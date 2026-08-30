/**
 * Ball detection and colour classification.
 *
 * Detection (plan Phase 1 step 4)
 * -------------------------------
 * Balls are found as *holes in the cloth mask* rather than by `HoughCircles`,
 * which needs an absolute radius range — and a ball's apparent radius varies
 * by a factor of 2-3 across a single oblique photo. Working from the cloth
 * mask instead gives a blob whose expected size can be predicted from the
 * recovered *pose* at that exact image location (`expectedBallRadiusPx`), so
 * the size filter is correct everywhere in the frame with no hand-tuned pixel
 * constants.
 *
 * That prediction treats the ball as a sphere, whose silhouette is a circle of
 * radius `f·r/d` — it is emphatically *not* the local scale of the cloth
 * plane. A sphere looks identical from every direction, so unlike the cloth it
 * does not foreshorten; predicting its size from the plane's Jacobian
 * understates a far-field ball by nearly 2x and the filter then throws away
 * real balls.
 *
 * Each blob outline is then fitted with a trimmed circle fit
 * (`fitCircleRobust`) rather than reduced to its centroid, because a ball's
 * cast shadow is also "not cloth" and can be swallowed into the same blob; a
 * plain centroid is pulled several millimetres towards the shadow, while a
 * trimmed circle fit rejects the shadow lobe as outliers.
 *
 * Two or more balls frozen together (touching, or apparently overlapping
 * under an oblique camera angle) are this connectivity-based approach's one
 * real blind spot: they merge into a single "not cloth" blob, too large and
 * too non-circular for any single-contour check above to ever accept. This is
 * where `HoughCircles` earns the exception the opening paragraph rules it out
 * for globally — `trySplitMergedBlob` runs it *locally*, restricted to a tight
 * crop around exactly this blob and a tight radius band around
 * `expectedBallRadiusPx` at that specific spot, which sidesteps the "no global
 * radius range" problem entirely.
 *
 * Classification (plan Phase 1 step 5)
 * ------------------------------------
 * Entirely relative — see `classifyBallColors`. No absolute hue/threshold
 * decides white vs. yellow, because a warm-lit hall makes a white ball read
 * more yellow than a yellow ball reads under LED light. Getting this wrong
 * swaps the cue ball and makes 100% of the downstream recommendations wrong
 * while still looking completely normal (plan Risk "인접 테이블/색상 오분류로
 * 큐볼 스왑"), so the decision margin is also reported and folded into the
 * confidence score.
 */

import type { BallColor } from '@/lib/types';
import {
  type CircleFit,
  type Vec2,
  distance,
  fitCircleRobust,
  pointInPolygon,
  shrinkPolygon,
} from './geometry';
import { type TableFrame, expectedBallRadiusPx } from './camera';
import { hueDistance } from './cloth';
import type { RgbaImage } from './image';
import { type CV, CvScope } from './opencv';

export interface BallCandidate {
  /** Sub-pixel ball centre in image coordinates. */
  center: Vec2;
  /**
   * Area-equivalent radius in image pixels: `√(area / π)`.
   *
   * Taken from the blob's area rather than the fitted circle's radius, so that
   * a blob distorted by a merged shadow or a clipped edge still yields a
   * stable size. Compared directly against `expectedRadiusPx`, which is also a
   * silhouette radius.
   */
  radiusPx: number;
  /** Radius a sphere at this spot should image with, from the recovered pose. */
  expectedRadiusPx: number;
  /** 4πA/P² of the source blob; 1.0 is a perfect circle. */
  circularity: number;
  /** Observed radius / expected radius; 1.0 is perfect agreement. */
  radiusRatio: number;
  /** Median RGB of the ball's inner disc. */
  rgb: [number, number, number];
  /** Combined shape-quality score in 0..1. */
  score: number;
}

export interface BallDetectionResult {
  candidates: BallCandidate[];
  /** Blobs that were examined but rejected, with the reason (for debugging). */
  rejected: Array<{ center: Vec2; reason: string }>;
}

/**
 * How far a blob's area-equivalent radius may deviate from the pose-predicted
 * silhouette radius. Measured ratios sit within roughly 15% of 1.0 across the
 * whole frame, the excess being the antialiased rim and any shadow the mask
 * did not reclaim, so the window can stay tight enough to actually reject junk
 * — a chalk cube, a cue tip, or a ball on a neighbouring table.
 */
const RADIUS_RATIO_RANGE: [number, number] = [0.6, 1.6];
/** Minimum 4πA/P². Cushion shadows and the cue are long and thin; balls are not. */
const MIN_CIRCULARITY = 0.55;

/**
 * How large a blob's area may be, as a multiple of one ball's expected
 * silhouette area, before it's worth attempting `trySplitMergedBlob` on it —
 * two or more balls frozen together read as a single connected "not cloth"
 * blob (see that function's doc). Below the low end it's just a normal
 * single ball (or genuine junk not shaped like any number of balls); above
 * the high end (more than all 4 balls on the table could plausibly cover) a
 * Hough search would only waste time chasing spurious circles in noise.
 */
const MERGED_BLOB_AREA_RANGE: [number, number] = [1.3, 4.5];

/**
 * How close (on the 0..179 hue wheel) a candidate's sampled colour may sit to
 * the cloth's own hue before it's rejected as spurious. A glare speck or dust
 * fleck can end up excluded from the cloth mask on saturation/value alone
 * (not hue — see `lib/vision/cloth.ts`'s own note on saturation instability
 * near black/white), forming a small "not cloth" blob that is otherwise
 * circular and ball-radius-sized enough to pass every other check, both here
 * and in `trySplitMergedBlob`. Once its own disc sample is averaged with the
 * ordinary felt around such a tiny fleck, the result reads as essentially
 * cloth-coloured — which no real ball (white, yellow, red) ever does; all
 * three sit far outside this margin from a typical blue-cloth hue.
 */
const CLOTH_HUE_REJECT_MARGIN = 25;

/** True when `rgb` is close enough to `clothHue` that it's almost certainly
 * sampling cloth (or a glare/dust speck averaged with the cloth around it),
 * not any real ball. See `CLOTH_HUE_REJECT_MARGIN`'s doc. */
function isClothColoured(rgb: readonly [number, number, number], clothHue: number): boolean {
  return hueDistance(colorFeatures(rgb).hue, clothHue) < CLOTH_HUE_REJECT_MARGIN;
}

/**
 * Find ball candidates inside the detected table quad.
 *
 * `clothMask` is the 8UC1 cloth mask; `rgb` is the 8UC3 RGB image. Both stay
 * owned by the caller.
 */
export function detectBalls(
  cv: CV,
  clothMask: InstanceType<CV['Mat']>,
  rgb: InstanceType<CV['Mat']>,
  image: RgbaImage,
  frame: TableFrame,
  tableQuad: readonly [Vec2, Vec2, Vec2, Vec2],
  ballRadiusMm: number,
  /** Dominant cloth hue (`ClothEstimate.hue`, `cloth.ts`) — used only by
   * `trySplitMergedBlob` to reject a Hough-found "ball" that's actually
   * sampling plain cloth. */
  clothHue: number
): BallDetectionResult {
  const scope = new CvScope();
  const rejected: Array<{ center: Vec2; reason: string }> = [];
  try {
    // Restrict to the playing surface, pulled in slightly: a ball frozen on the
    // cushion is a legal position, but the cushion nose itself is not cloth and
    // would otherwise become a ring-shaped "blob" around the whole table.
    const inner = shrinkPolygon(tableQuad, 0.02);
    // `Mat.zeros` is a static factory on the Mat class, not a constructor.
    const insideMask = scope.track(cv.Mat.zeros(image.height, image.width, cv.CV_8UC1));
    fillQuad(cv, scope, insideMask, inner);

    // Not-cloth ∧ inside-table.
    const notCloth = scope.track(new cv.Mat());
    cv.bitwise_not(clothMask, notCloth);
    const objects = scope.track(new cv.Mat());
    cv.bitwise_and(notCloth, insideMask, objects);

    // Open with a kernel a fraction of a ball wide: removes chalk dust, cloth
    // scuffs and mask speckle without eating an actual ball.
    const nominalRadiusPx = expectedBallRadiusPx(frame, centroidOf(tableQuad), ballRadiusMm);
    const k = Math.max(3, Math.round(nominalRadiusPx * 0.35) | 1);
    const kernel = scope.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    cv.morphologyEx(objects, objects, cv.MORPH_OPEN, kernel);

    const contours = scope.track(new cv.MatVector());
    const hierarchy = scope.track(new cv.Mat());
    cv.findContours(objects, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    const candidates: BallCandidate[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = scope.track(contours.get(i));
      const area = cv.contourArea(contour);
      const perimeter = cv.arcLength(contour, true);
      if (perimeter < 1e-6 || area < 8) continue;

      const points = matToPoints(contour);
      const rough = averagePoint(points);
      if (!pointInPolygon(inner, rough)) {
        rejected.push({ center: rough, reason: 'outside the table quad' });
        continue;
      }

      const circularity = (4 * Math.PI * area) / (perimeter * perimeter);

      // Two or more balls frozen together (touching, or apparently
      // overlapping under this camera's oblique angle) merge into one
      // connected blob — too large and too non-circular to be a single ball,
      // so the checks below would always reject it outright (see module
      // README's "Known limitations"). Try to recover the individual balls
      // before falling through to that rejection.
      const roughExpectedRadiusPx = expectedBallRadiusPx(frame, rough, ballRadiusMm);
      const singleBallAreaPx = roughExpectedRadiusPx > 0 ? Math.PI * roughExpectedRadiusPx ** 2 : 0;
      const areaRatio = singleBallAreaPx > 0 ? area / singleBallAreaPx : 0;
      if (areaRatio >= MERGED_BLOB_AREA_RANGE[0] && areaRatio <= MERGED_BLOB_AREA_RANGE[1]) {
        const split = trySplitMergedBlob(cv, scope, rgb, image, frame, contour, ballRadiusMm, inner, clothHue);
        if (split.length >= 2) {
          candidates.push(...split);
          continue;
        }
      }

      if (circularity < MIN_CIRCULARITY) {
        rejected.push({ center: rough, reason: `circularity ${circularity.toFixed(2)} too low` });
        continue;
      }

      let fit: CircleFit;
      try {
        fit = fitCircleRobust(points);
      } catch {
        rejected.push({ center: rough, reason: 'circle fit degenerate' });
        continue;
      }

      // Size from the blob's area, not the circle fit — see `radiusPx`.
      const equivalentRadiusPx = Math.sqrt(area / Math.PI);

      const expectedRadiusPx = expectedBallRadiusPx(frame, fit.center, ballRadiusMm);
      if (!(expectedRadiusPx > 0)) {
        rejected.push({ center: fit.center, reason: 'ball plane unreachable from the recovered pose' });
        continue;
      }
      const radiusRatio = equivalentRadiusPx / expectedRadiusPx;
      if (radiusRatio < RADIUS_RATIO_RANGE[0] || radiusRatio > RADIUS_RATIO_RANGE[1]) {
        rejected.push({
          center: fit.center,
          reason: `area-equivalent radius ${equivalentRadiusPx.toFixed(1)}px is ${radiusRatio.toFixed(2)}x the expected ${expectedRadiusPx.toFixed(1)}px`,
        });
        continue;
      }

      // Sample well inside the blob's *shorter* axis so an elongated far-field
      // ball still yields interior pixels rather than cushion or shadow.
      const rgbSample = sampleDiscMedianRgb(rgb, image, fit.center, equivalentRadiusPx * 0.5);
      if (!rgbSample) {
        rejected.push({ center: fit.center, reason: 'no sampleable interior pixels' });
        continue;
      }
      if (isClothColoured(rgbSample, clothHue)) {
        rejected.push({ center: fit.center, reason: 'sampled colour is essentially cloth-coloured' });
        continue;
      }

      // Both factors are independently necessary, so they multiply. The
      // circle fit's residual is deliberately NOT scored: for a foreshortened
      // ball it measures the ellipse's eccentricity, not the quality of the
      // detection, and penalising it would down-rank every far-field ball.
      const shape = Math.min(1, circularity);
      const sizeAgreement = Math.exp(-(((radiusRatio - 1) / 0.3) ** 2));
      candidates.push({
        center: fit.center,
        radiusPx: equivalentRadiusPx,
        expectedRadiusPx,
        circularity,
        radiusRatio,
        rgb: rgbSample,
        score: shape * sizeAgreement,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return { candidates, rejected };
  } finally {
    scope.dispose();
  }
}

/**
 * Recover individual balls from a blob too large/non-circular to be one ball
 * — the connectivity-based approach above has no way to tell "one big blob"
 * apart from "several balls touching", so it always rejects the latter (see
 * module README's "Known limitations": "Balls touching or occluding each
 * other merge into one blob").
 *
 * Runs `HoughCircles` restricted to a tight crop around the blob and a tight
 * radius band around the *locally* pose-predicted ball radius. The module doc
 * on `detectBalls` explains why an unrestricted `HoughCircles` is impractical
 * (a ball's apparent radius varies 2-3x across one photo, and there is no way
 * to give it a global radius range) — but that objection evaporates once both
 * the search region and the radius range are this tightly constrained, which
 * is only possible *because* a merged blob has already told us roughly where
 * to look and `expectedBallRadiusPx` already tells us roughly how big to look
 * for. `HOUGH_GRADIENT`'s edge-based method finds each ball's own curved
 * boundary directly, unlike the contour/circularity path above which can only
 * ever see the *merged shape's* boundary.
 */
function trySplitMergedBlob(
  cv: CV,
  scope: CvScope,
  rgb: InstanceType<CV['Mat']>,
  image: RgbaImage,
  frame: TableFrame,
  contour: InstanceType<CV['Mat']>,
  ballRadiusMm: number,
  inner: readonly Vec2[],
  clothHue: number
): BallCandidate[] {
  const rect = cv.boundingRect(contour);
  const padding = Math.max(4, Math.round(Math.max(rect.width, rect.height) * 0.15));
  const x0 = Math.max(0, rect.x - padding);
  const y0 = Math.max(0, rect.y - padding);
  const x1 = Math.min(image.width, rect.x + rect.width + padding);
  const y1 = Math.min(image.height, rect.y + rect.height + padding);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 4 || h < 4) return [];

  const expectedAtCenter = expectedBallRadiusPx(frame, { x: x0 + w / 2, y: y0 + h / 2 }, ballRadiusMm);
  if (!(expectedAtCenter > 0)) return [];
  const minRadius = Math.max(2, Math.round(expectedAtCenter * 0.7));
  const maxRadius = Math.max(minRadius + 1, Math.round(expectedAtCenter * 1.3));

  const crop = scope.track(rgb.roi(new cv.Rect(x0, y0, w, h)));
  const gray = scope.track(new cv.Mat());
  cv.cvtColor(crop, gray, cv.COLOR_RGB2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  const circles = scope.track(new cv.Mat());
  cv.HoughCircles(
    gray,
    circles,
    cv.HOUGH_GRADIENT,
    1,
    // minDist between circle centres, kept deliberately low (below the ~2x
    // radius apart two genuinely touching balls' true centres sit at). Under
    // an oblique enough angle their *apparent* separation compresses well
    // below that 2x figure too (the same perspective effect
    // `expectedBallRadiusPx`'s doc already warns single-ball-radius
    // predictions need sphere-aware math for) — verified against a real
    // rendered case at ~1.4x. That leaves too little headroom above the
    // ~1.2x a jittered duplicate fit of one real ball sits at for `minDist`
    // to safely tell the two apart on distance alone, so this stays low
    // (favouring "find both circles") and the *scored, colour-aware*
    // dedup below — not this geometry-only Hough parameter — is what
    // actually discards a same-ball duplicate.
    expectedAtCenter * 1.2,
    80, // Canny high threshold (low threshold is half this, per HOUGH_GRADIENT's contract)
    // Accumulator threshold, well below the ~100 default: a ball whose rim is
    // half-occluded by the other ball it's touching casts far fewer votes
    // than an isolated one, and this only runs inside an already-tight crop
    // (not scanning the whole photo), so the usual false-positive risk of a
    // low threshold is contained — anything spurious still has to pass the
    // radius-ratio and colour-sample checks below to become a candidate.
    8,
    minRadius,
    maxRadius
  );

  const found: BallCandidate[] = [];
  for (let i = 0; i < circles.cols; i++) {
    const center: Vec2 = { x: circles.data32F[i * 3] + x0, y: circles.data32F[i * 3 + 1] + y0 };
    const r = circles.data32F[i * 3 + 2];
    if (!pointInPolygon(inner, center)) continue;

    const expectedRadiusPx = expectedBallRadiusPx(frame, center, ballRadiusMm);
    if (!(expectedRadiusPx > 0)) continue;
    const radiusRatio = r / expectedRadiusPx;
    if (radiusRatio < RADIUS_RATIO_RANGE[0] || radiusRatio > RADIUS_RATIO_RANGE[1]) continue;

    const rgbSample = sampleDiscMedianRgb(rgb, image, center, r * 0.5);
    if (!rgbSample) continue;
    if (isClothColoured(rgbSample, clothHue)) continue;

    const sizeAgreement = Math.exp(-(((radiusRatio - 1) / 0.3) ** 2));
    found.push({
      center,
      radiusPx: r,
      expectedRadiusPx,
      // Hough found an actual circular edge, not a shape contour — there is
      // no blob-shape circularity to measure here, so this reports "as
      // circular as physically meaningful" rather than an invented number.
      circularity: 1,
      radiusRatio,
      rgb: rgbSample,
      // A mild, fixed penalty vs. a clean isolated-ball contour fit: this
      // candidate came from a merged/occluded blob, a genuinely harder case
      // to have gotten right, so it should not out-rank an equally-sized
      // clean detection when `detectBalls`'s caller keeps only the top 4.
      score: sizeAgreement * 0.9,
    });
  }

  // A real ball merged with its own cast shadow (not a second ball) is a
  // distinct failure mode from a genuine touching pair, and the checks above
  // do not tell them apart: a shadow lobe can easily be round enough and
  // "expected-radius"-sized enough to pass both. What it cannot do is be
  // anywhere near as *bright* as an actually-lit ball surface — every real
  // ball colour sampled elsewhere in this pipeline sits north of ~200 on its
  // brightest channel, while a shadow on blue cloth measured in the wild here
  // came in at 79. Two genuinely different touching balls (even white next to
  // a darker red) are never anywhere close to a 2x brightness gap the way a
  // ball-vs-its-own-shadow pair is, so this stays a safe, purely *relative*
  // comparison within this one blob rather than a hand-tuned absolute cutoff.
  if (found.length >= 2) {
    const brightest = Math.max(...found.map((c) => Math.max(...c.rgb)));
    for (let i = found.length - 1; i >= 0; i--) {
      if (Math.max(...found[i].rgb) < brightest * 0.5) found.splice(i, 1);
    }
  }

  // Two "circles" whose centres are implausibly close are the same physical
  // ball found twice, not two touching balls — this is the check that
  // actually tells them apart (see `minDist`'s doc above for why Hough's own
  // distance-only parameter is kept too low to do this safely by itself). A
  // real duplicate fit of one ball measured ~1.2x its expected radius apart
  // in a real photo; a genuinely touching pair's *apparent* separation
  // measured as low as ~1.4x in an oblique synthetic render. 1.3x sits
  // between those two observations — narrow, and worth revisiting once more
  // real photos exist, but scored (not distance-only) dedup is what makes
  // that workable at all: keep only the higher-scoring, colour-validated one
  // of any such pair.
  found.sort((a, b) => b.score - a.score);
  const deduped: BallCandidate[] = [];
  for (const c of found) {
    if (
      deduped.some(
        (d) => distance(d.center, c.center) < 1.3 * Math.min(c.expectedRadiusPx, d.expectedRadiusPx)
      )
    ) {
      continue;
    }
    deduped.push(c);
  }
  return deduped;
}

function centroidOf(poly: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

function averagePoint(points: readonly Vec2[]): Vec2 {
  return centroidOf(points);
}

function matToPoints(contour: InstanceType<CV['Mat']>): Vec2[] {
  const data = contour.data32S;
  const out: Vec2[] = new Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = { x: data[i * 2], y: data[i * 2 + 1] };
  return out;
}

function fillQuad(
  cv: CV,
  scope: CvScope,
  target: InstanceType<CV['Mat']>,
  quad: readonly Vec2[]
): void {
  const flat: number[] = [];
  for (const p of quad) flat.push(Math.round(p.x), Math.round(p.y));
  const poly = scope.track(cv.matFromArray(quad.length, 1, cv.CV_32SC2, flat));
  const polys = scope.track(new cv.MatVector());
  polys.push_back(poly);
  cv.fillPoly(target, polys, new cv.Scalar(255));
}

/**
 * Per-channel median RGB over the disc of radius `radius` about `center`.
 * Median rather than mean so a specular highlight — always present on a
 * polished ball under hall lighting — cannot drag the reading towards white.
 */
function sampleDiscMedianRgb(
  rgbMat: InstanceType<CV['Mat']>,
  image: RgbaImage,
  center: Vec2,
  radius: number
): [number, number, number] | null {
  const r = Math.max(1.5, radius);
  const x0 = Math.max(0, Math.floor(center.x - r));
  const x1 = Math.min(image.width - 1, Math.ceil(center.x + r));
  const y0 = Math.max(0, Math.floor(center.y - r));
  const y1 = Math.min(image.height - 1, Math.ceil(center.y + r));

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const data = rgbMat.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (distance({ x, y }, center) > r) continue;
      const i = (y * image.width + x) * 3;
      rs.push(data[i]);
      gs.push(data[i + 1]);
      bs.push(data[i + 2]);
    }
  }
  if (rs.length < 5) return null;
  return [median(rs), median(gs), median(bs)];
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Relative colour classification
// ---------------------------------------------------------------------------

/** Colour features derived from a ball's median RGB, all scale-free. */
export interface ColorFeatures {
  /** Hue on OpenCV's 0..179 wheel. */
  hue: number;
  /** (max − min) / 255. How colourful, independent of brightness. */
  chroma: number;
  /** B / (R+G+B). ≈1/3 for a neutral ball, markedly lower for yellow. */
  blueShare: number;
}

export function colorFeatures(rgb: readonly [number, number, number]): ColorFeatures {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 30; // 0..179 scale (degrees / 2)
    if (hue < 0) hue += 180;
  }
  const sum = r + g + b;
  return {
    hue,
    chroma: delta / 255,
    blueShare: sum > 0 ? b / sum : 1 / 3,
  };
}

export interface ColorAssignment {
  /** Index into the input array for each colour. */
  indices: Record<BallColor, number>;
  /**
   * Margin between the best and second-best hypothesis, normalised to 0..1.
   * Near 0 means two different colour assignments explained the photo about
   * equally well — exactly the cue-ball-swap failure the plan warns about, so
   * this drives the confidence score down and the user to the correction screen.
   */
  margin: number;
  /** Human-readable explanation of the winning hypothesis, for logs. */
  rationale: string;
}

/**
 * Assign white / yellow / red1 / red2 to exactly four detected balls using
 * only *relative* comparisons.
 *
 * Method: enumerate all six ways to pick the red pair out of four balls. Score
 * each hypothesis on properties that hold under any lighting:
 *
 *   - the two reds must agree with each other in hue (same paint, same lamp);
 *   - the two reds must both be more colourful than the ball called white;
 *   - the ball called white must be the least colourful of the four;
 *   - the ball called yellow must be less blue than the ball called white
 *     (yellow is by definition blue-deficient — this is the *only* white/yellow
 *     discriminator used, and it is a comparison between the two candidates,
 *     never a threshold on either one).
 *
 * The best hypothesis wins; the gap to the runner-up becomes the confidence
 * margin. With only four balls this exhaustive search is 6 hypotheses × a
 * handful of arithmetic ops — cheaper than any clustering approach and, unlike
 * clustering, it cannot return a degenerate assignment.
 */
export function classifyBallColors(
  rgbs: ReadonlyArray<readonly [number, number, number]>
): ColorAssignment {
  if (rgbs.length !== 4) {
    throw new Error(`classifyBallColors: expected exactly 4 balls, got ${rgbs.length}`);
  }
  const f = rgbs.map(colorFeatures);
  const redPairs: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];

  interface Hypothesis {
    score: number;
    red: [number, number];
    white: number;
    yellow: number;
    rationale: string;
  }
  const hypotheses: Hypothesis[] = [];

  for (const [i, j] of redPairs) {
    const others = [0, 1, 2, 3].filter((k) => k !== i && k !== j);
    // Within the two non-red balls, whichever is *less blue* is the yellow one.
    const [p, q] = others;
    const yellow = f[p].blueShare < f[q].blueShare ? p : q;
    const white = yellow === p ? q : p;

    // 1. Red pair hue agreement. Two balls of the same paint under the same
    //    lamp land within a few degrees of each other.
    const hueGap = hueDistance(f[i].hue, f[j].hue);
    const redAgreement = Math.exp(-((hueGap / 12) ** 2));

    // 2. Both reds must out-colour the white ball, by a margin relative to the
    //    scene's own chroma scale rather than an absolute number.
    const chromaScale = Math.max(1e-3, (f[i].chroma + f[j].chroma + f[yellow].chroma) / 3);
    const redVsWhite =
      sigmoid((Math.min(f[i].chroma, f[j].chroma) - f[white].chroma) / (0.5 * chromaScale));

    // 3. White must be the least colourful ball present.
    const whiteIsLeastChromatic = f.every((x, k) => k === white || x.chroma >= f[white].chroma)
      ? 1
      : 0.25;

    // 4. Yellow must be measurably less blue than white — the relative
    //    white/yellow discriminator. Normalised by the pair's own mean so a
    //    dim photo is judged on the same scale as a bright one.
    const blueMean = Math.max(1e-3, (f[white].blueShare + f[yellow].blueShare) / 2);
    const yellowVsWhite = sigmoid((f[white].blueShare - f[yellow].blueShare) / (0.08 * blueMean));

    const score = redAgreement * redVsWhite * whiteIsLeastChromatic * yellowVsWhite;
    hypotheses.push({
      score,
      red: [i, j],
      white,
      yellow,
      rationale:
        `reds=[${i},${j}] hueGap=${hueGap.toFixed(1)} white=${white} yellow=${yellow} ` +
        `redAgreement=${redAgreement.toFixed(3)} redVsWhite=${redVsWhite.toFixed(3)} ` +
        `yellowVsWhite=${yellowVsWhite.toFixed(3)}`,
    });
  }

  hypotheses.sort((a, b) => b.score - a.score);
  const best = hypotheses[0];
  const runnerUp = hypotheses[1];
  const margin =
    best.score > 1e-9 ? Math.max(0, Math.min(1, (best.score - runnerUp.score) / best.score)) : 0;

  // red1 / red2 are interchangeable; fix a deterministic order so repeated runs
  // on the same photo produce identical ball ids.
  const [redA, redB] = best.red;

  return {
    indices: { white: best.white, yellow: best.yellow, red1: redA, red2: redB },
    margin,
    rationale: best.rationale,
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
