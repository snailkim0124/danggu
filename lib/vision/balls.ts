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
  ballRadiusMm: number
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
