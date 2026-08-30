/**
 * Table boundary detection: the four cushion-nose lines and their intersections.
 *
 * Approach (plan Phase 1 step 2)
 * ------------------------------
 * The plan is explicit that the boundary must come from **four fitted lines
 * intersected pairwise**, not from four detected corner points, so that a
 * corner cropped out of frame is still recoverable. What is fitted here is the
 * *cloth mask boundary* rather than raw Hough segments:
 *
 *   1. Segment the cloth (`cloth.ts`) and take its largest contour.
 *   2. Drop every contour point sitting on the image border — that part of the
 *      outline is the frame edge, not a cushion, and it is precisely what
 *      would poison a line fit when a corner is out of shot.
 *   3. Use `minAreaRect` only as an *orientation prior*: it tells us roughly
 *      where the four sides are, so contour points can be assigned to sides.
 *   4. Fit each side independently with total-least-squares
 *      (`fitLineTls`) and re-assign/refit twice, so each side is a real
 *      line estimated from hundreds of boundary pixels.
 *   5. Intersect adjacent side lines to get the four corners. A corner outside
 *      the image is simply an extrapolated intersection and costs nothing.
 *
 * Why not `HoughLinesP` on a Canny edge map: OpenCV.js exposes it, but on a
 * real hall photo it returns dozens of segments from rails, chalk lines,
 * reflections, neighbouring tables and the cue, and the hard part becomes
 * choosing which four are the cushions — for which you need the cloth region
 * anyway. Going through the mask boundary gets a *segmentation-verified* set
 * of edge points first and then does the same line algebra, which is strictly
 * better conditioned. `approxPolyDP`/`minAreaRect` alone were rejected for the
 * opposite reason: both produce corner points and both fail exactly when a
 * corner leaves the frame.
 *
 * Known failure modes are listed on `TableDetectionResult.warnings` and in the
 * module README.
 */

import type { Point, TableDetection, TableSize } from '@/lib/types';
import {
  type Line2,
  type Vec2,
  distance,
  distanceToLine,
  fitLineTls,
  lineIntersection,
  orderQuadClockwise,
  polygonArea,
} from './geometry';
import type { RgbaImage } from './image';
import { type CV, CvScope } from './opencv';

export interface SideFit {
  line: Line2;
  rmsResidual: number;
  pointCount: number;
  /** Length of the visible (non-border) span of this side, in pixels. */
  spanPx: number;
  /**
   * The fitted points' own extent along the line direction (`rangeAlongLine`'s
   * `(dx,dy) = (-line.b, line.a)` parametrisation), i.e.
   * `spanPx === rangeHi - rangeLo`. Kept separately (not just the length) so
   * a corner's position can be checked against where the *actual* evidence
   * sits, not just how much of it there was — see `cornerExtrapolationErrorPx`.
   */
  rangeLo: number;
  rangeHi: number;
}

export interface TableDetectionResult {
  detection: TableDetection;
  sides: [SideFit, SideFit, SideFit, SideFit];
  /** Corners that fell outside the image — extrapolated, not observed. */
  cornersOutOfFrame: number;
  /** Fraction of the image the cloth mask covers. */
  clothCoverage: number;
  /** Aspect ratio of the fitted quad's opposite-side midlines (long / short). */
  observedAspectRatio: number;
  /**
   * Per-corner (same order as `detection.boundary`) estimated positional
   * error, in image pixels, from extrapolating that corner's two contributing
   * side-fits past where they actually had evidence — see
   * `cornerExtrapolationErrorPx`. 0 for a corner that fell within (was
   * interpolated from) both sides' observed data. Feeds `scoreConfidence`
   * (folded into the same signal `sides[].rmsResidual` does) rather than
   * gating anything here directly.
   */
  cornerExtrapolationErrorPx: [number, number, number, number];
  warnings: string[];
}

/**
 * How close to the image edge a contour point must be to count as "the frame
 * cut it off", as a fraction of the smaller image dimension.
 */
const BORDER_MARGIN_FRACTION = 0.004;

/** Minimum boundary pixels a cushion side must contribute to count as observed. */
const MIN_SIDE_POINTS = 25;
/** Minimum visible extent of a cushion side, as a fraction of the image diagonal. */
const MIN_SIDE_SPAN_FRACTION = 0.06;

/**
 * Detect the table boundary from a pre-computed cloth mask.
 *
 * `mask` is an 8UC1 Mat (255 = cloth); ownership stays with the caller.
 */
export function detectTableBoundary(
  cv: CV,
  mask: InstanceType<CV['Mat']>,
  image: RgbaImage,
  size: TableSize
): TableDetectionResult {
  const scope = new CvScope();
  const warnings: string[] = [];
  try {
    const contour = largestExternalContour(cv, scope, mask);
    if (!contour) {
      throw new Error(
        'No cloth region found. The photo may not contain a billiard table, or the ' +
          'cloth may be too dark/washed out to segment.'
      );
    }

    const allPoints = contourToPoints(contour);
    const contourArea = polygonArea(allPoints);
    const clothCoverage = contourArea / (image.width * image.height);
    if (clothCoverage < 0.05) {
      warnings.push(
        `Cloth region covers only ${(clothCoverage * 100).toFixed(1)}% of the frame; the ` +
          'table is probably too small or partly mis-segmented.'
      );
    }

    const margin = Math.max(2, Math.round(Math.min(image.width, image.height) * BORDER_MARGIN_FRACTION));
    const edgePoints = allPoints.filter((p) => !isOnImageBorder(p, image, margin));
    if (edgePoints.length < 4 * 20) {
      throw new Error(
        `Only ${edgePoints.length} usable cushion-edge pixels after discarding the image ` +
          'border; the table fills too much of the frame to fit four sides. Step back and retake.'
      );
    }
    if (edgePoints.length < allPoints.length * 0.9) {
      warnings.push(
        `${(100 * (1 - edgePoints.length / allPoints.length)).toFixed(0)}% of the cloth outline ` +
          'lies on the image border — the table is cropped, so at least one corner is extrapolated.'
      );
    }

    const priorSides = minAreaRectSides(cv, contour);
    const sides = fitFourSides(edgePoints, priorSides, image);

    // A side with no real evidence behind it is the one failure this approach
    // must never paper over. When a whole cushion is outside the frame, the
    // rough `minAreaRect` prior for that side sits on the *image border*, and
    // fitting the remaining three sides against it yields a confident-looking
    // quad that is simply the visible crop — corners "in frame", small
    // residuals, and every millimetre downstream wrong. Four partially-visible
    // cushions are enough (that is the whole point of intersecting lines
    // rather than detecting corners); fewer than four is not recoverable.
    const diagonal = Math.hypot(image.width, image.height);
    const starved = sides
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.pointCount < MIN_SIDE_POINTS || s.spanPx < diagonal * MIN_SIDE_SPAN_FRACTION);
    if (starved.length > 0) {
      throw new Error(
        `Cushion side(s) ${starved.map((x) => x.i).join(', ')} were not visible enough to fit ` +
          `(${starved
            .map((x) => `side ${x.i}: ${x.s.pointCount}px of evidence spanning ${x.s.spanPx.toFixed(0)}px`)
            .join('; ')}). All four cushions must be at least partly in frame — ` +
          'step back or raise the camera so every cushion edge is visible.'
      );
    }

    const corners: Vec2[] = [];
    for (let i = 0; i < 4; i++) {
      const c = lineIntersection(sides[i].line, sides[(i + 1) % 4].line);
      if (!c) {
        throw new Error(
          `Cushion sides ${i} and ${(i + 1) % 4} are near-parallel, so their corner cannot be ` +
            'located. The table outline was not detected cleanly.'
        );
      }
      corners.push(c);
    }

    // See `cornerExtrapolationErrorPx`'s doc: a corner can land far outside
    // the real table even when both contributing sides individually look
    // like clean fits (the `starved` check above only looks at each side on
    // its own) — a *precise* line can still be extrapolated arbitrarily far
    // safely (a clean synthetic render's fitted line has ~0 RMS, so even a
    // corner cropped out of frame costs nothing, exactly per this module's
    // design goal), so distance alone can't be the criterion. This scales the
    // extrapolation distance by the fit's own angular uncertainty instead,
    // and — matching how every other soft signal here works (`rectangleConsistency`,
    // side RMS) — feeds `scoreConfidence` rather than failing outright: a
    // corner extrapolated from an imprecise line should read as *uncertain*,
    // not silently wrong, but a real photo can still have exactly one dicey
    // corner while the rest of the table is fine.
    // Keyed by object identity, not index — `orderQuadClockwise` below
    // reorders `corners` into `boundary`, and this must follow that same
    // reordering rather than staying in "corner i = sides[i] ∩ sides[i+1]"
    // construction order.
    const cornerErrorByPoint = new Map<Vec2, number>(
      corners.map((c, i) => [
        c,
        Math.max(cornerExtrapolationErrorPx(c, sides[i]), cornerExtrapolationErrorPx(c, sides[(i + 1) % 4])),
      ])
    );

    const boundary = orderQuadClockwise(corners);
    const cornerExtrapolationErrorsPx = boundary.map((c) => cornerErrorByPoint.get(c) ?? 0) as [
      number,
      number,
      number,
      number,
    ];
    const quadArea = polygonArea(boundary);
    if (!(quadArea > 0.5 * contourArea) || quadArea > 4 * contourArea) {
      warnings.push(
        `Fitted quad area (${quadArea.toFixed(0)}px²) disagrees with the cloth contour area ` +
          `(${contourArea.toFixed(0)}px²); the side fits may have latched onto the wrong edges.`
      );
    }

    const cornersOutOfFrame = boundary.filter(
      (c) => c.x < 0 || c.y < 0 || c.x > image.width || c.y > image.height
    ).length;

    const observedAspectRatio = quadAspectRatio(boundary);

    const worstCornerErrorPx = Math.max(...cornerExtrapolationErrorsPx);
    if (worstCornerErrorPx > diagonal * WARN_CORNER_ERROR_FRACTION) {
      warnings.push(
        `A corner was extrapolated from a noisy line fit far enough past its evidence to carry ` +
          `~${worstCornerErrorPx.toFixed(0)}px of estimated positional error — this photo's table ` +
          'fit confidence will reflect that.'
      );
    }

    return {
      detection: { boundary, size },
      sides,
      cornersOutOfFrame,
      clothCoverage,
      observedAspectRatio,
      cornerExtrapolationErrorPx: cornerExtrapolationErrorsPx,
      warnings,
    };
  } finally {
    scope.dispose();
  }
}

/**
 * Ratio of the quad's long axis to its short axis, measured between opposite
 * side midpoints so perspective foreshortening of a single edge cannot
 * dominate. Compared against the table's true 2:1-ish ratio as an independent
 * sanity check on the detection — it uses no information the fit itself used.
 */
export function quadAspectRatio(quad: readonly [Vec2, Vec2, Vec2, Vec2]): number {
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const axisA = distance(mid(quad[0], quad[1]), mid(quad[2], quad[3]));
  const axisB = distance(mid(quad[1], quad[2]), mid(quad[3], quad[0]));
  const long = Math.max(axisA, axisB);
  const short = Math.min(axisA, axisB);
  return short > 1e-6 ? long / short : Infinity;
}

function isOnImageBorder(p: Vec2, image: RgbaImage, margin: number): boolean {
  return (
    p.x <= margin ||
    p.y <= margin ||
    p.x >= image.width - 1 - margin ||
    p.y >= image.height - 1 - margin
  );
}

function largestExternalContour(
  cv: CV,
  scope: CvScope,
  mask: InstanceType<CV['Mat']>
): InstanceType<CV['Mat']> | null {
  const contours = scope.track(new cv.MatVector());
  const hierarchy = scope.track(new cv.Mat());
  // CHAIN_APPROX_NONE: we want every boundary pixel, because the line fits are
  // only as good as the number of samples per side. SIMPLE would collapse each
  // straight run to two endpoints and throw away the evidence.
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

  let best: InstanceType<CV['Mat']> | null = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  if (best) scope.track(best);
  return best;
}

function contourToPoints(contour: InstanceType<CV['Mat']>): Vec2[] {
  const data = contour.data32S;
  const points: Vec2[] = new Array(data.length / 2);
  for (let i = 0; i < points.length; i++) {
    points[i] = { x: data[i * 2], y: data[i * 2 + 1] };
  }
  return points;
}

/**
 * Four approximate side lines from `minAreaRect`, used only to seed the
 * point-to-side assignment. Their accuracy does not matter much: the TLS refit
 * loop moves each line onto the real edge within a couple of iterations.
 */
function minAreaRectSides(
  cv: CV,
  contour: InstanceType<CV['Mat']>
): [Line2, Line2, Line2, Line2] {
  const rect = cv.minAreaRect(contour);
  // `RotatedRect.points` returns plain JS objects, not WASM-heap handles, so
  // there is nothing to release here.
  const corners = cv.RotatedRect.points(rect) as Array<{ x: number; y: number }>;
  const ordered = orderQuadClockwise(corners.map((p) => ({ x: p.x, y: p.y })));
  return [
    sideLine(ordered[0], ordered[1]),
    sideLine(ordered[1], ordered[2]),
    sideLine(ordered[2], ordered[3]),
    sideLine(ordered[3], ordered[0]),
  ];
}

function sideLine(a: Vec2, b: Vec2): Line2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const na = -dy / len;
  const nb = dx / len;
  return { a: na, b: nb, c: -(na * a.x + nb * a.y) };
}

/**
 * Assign boundary points to the four sides and refit each with TLS, iterating
 * so the fits converge onto the true cushion lines rather than the rough
 * `minAreaRect` prior.
 *
 * Points further than `tolerance` from every side are dropped: those are the
 * rounded corner pockets of the mask and any segmentation spill, and including
 * them would bend every side towards its neighbours.
 */
function fitFourSides(
  points: readonly Vec2[],
  prior: [Line2, Line2, Line2, Line2],
  image: RgbaImage
): [SideFit, SideFit, SideFit, SideFit] {
  let lines: Line2[] = [...prior];
  let groups: Vec2[][] = [[], [], [], []];
  const diagonal = Math.hypot(image.width, image.height);

  for (let iteration = 0; iteration < 3; iteration++) {
    // Tolerance tightens each round: start loose enough to capture the edge
    // despite a crude prior, then close in so only true edge pixels remain.
    const tolerance = diagonal * [0.05, 0.02, 0.01][iteration];
    groups = [[], [], [], []];
    for (const p of points) {
      let bestSide = -1;
      let bestDist = tolerance;
      for (let s = 0; s < 4; s++) {
        const d = distanceToLine(lines[s], p);
        if (d < bestDist) {
          bestDist = d;
          bestSide = s;
        }
      }
      if (bestSide >= 0) groups[bestSide].push(p);
    }

    const next: Line2[] = [];
    for (let s = 0; s < 4; s++) {
      if (groups[s].length < 10) {
        // Not enough evidence to move this side; keep the previous estimate.
        next.push(lines[s]);
        continue;
      }
      next.push(fitLineTls(groups[s]).line);
    }
    lines = next;
  }

  const fits = lines.map((line, s): SideFit => {
    const pts = groups[s];
    if (pts.length < 2) {
      return { line, rmsResidual: Infinity, pointCount: pts.length, spanPx: 0, rangeLo: 0, rangeHi: 0 };
    }
    const fit = fitLineTls(pts);
    const { lo, hi } = rangeAlongLine(pts, fit.line);
    return {
      line: fit.line,
      rmsResidual: fit.rmsResidual,
      pointCount: pts.length,
      spanPx: hi - lo,
      rangeLo: lo,
      rangeHi: hi,
    };
  });

  return fits as [SideFit, SideFit, SideFit, SideFit];
}

/** `[lo, hi]` of the points' projections onto the line's own direction —
 * `(dx, dy) = (-line.b, line.a)`. `hi - lo` is the side's `spanPx`; the range
 * itself (not just its length) is what `extrapolationRatio` needs. */
function rangeAlongLine(points: readonly Vec2[], line: Line2): { lo: number; hi: number } {
  const dx = -line.b;
  const dy = line.a;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = p.x * dx + p.y * dy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { lo, hi };
}

/**
 * Estimated positional error, in image pixels, from extrapolating a corner
 * past where its side's fitted points actually had evidence.
 *
 * Found necessary from real photos (2026-08-30, steep/close table shots —
 * see `docs/testing/geometric-gate-guide.md` results and
 * `scripts/visualize-boundary.ts`): a corner's two contributing sides can
 * each individually look like a perfectly reasonable fit (single-digit-px
 * RMS, a span well above `MIN_SIDE_SPAN_FRACTION`) while the line-intersection
 * corner they produce still lands far outside the real table, because a tiny
 * angular error in a short, only-mildly-noisy line segment swings wildly once
 * projected far past where that segment actually had evidence. Per-side
 * RMS/span numbers alone cannot see this — it only shows up by asking "how
 * far beyond what we actually measured is this corner, and how much did that
 * matter given how precise the line actually was?".
 *
 * That last clause is why this returns an *error estimate*, not a raw
 * extrapolation distance or a distance/span ratio: distance alone can't be
 * the criterion, because a genuinely precise line (a clean synthetic render's
 * fitted line has ~0 RMS) can be extrapolated arbitrarily far with no real
 * cost — a corner cropped out of frame entirely is exactly the case this
 * module is designed to still recover (see the module docstring), and a
 * first version of this check that rejected on distance alone broke that
 * exact case (`pipeline.test.ts` "still recovers the table when a corner is
 * cropped out of frame"). Treating the side's own span as the lever arm its
 * angular precision was measured over, `rmsResidual / spanPx` is a rough
 * angular-uncertainty proxy (radians, small-angle), so multiplying it by the
 * actual extrapolation distance gives an error estimate that stays ~0 for a
 * precise line no matter how far it's extrapolated, and grows for a noisy
 * one.
 */
export function cornerExtrapolationErrorPx(corner: Vec2, side: SideFit): number {
  const dx = -side.line.b;
  const dy = side.line.a;
  const t = corner.x * dx + corner.y * dy;
  const beyond = Math.max(0, side.rangeLo - t, t - side.rangeHi);
  if (beyond <= 0) return 0;
  const span = Math.max(side.spanPx, 1);
  return beyond * (side.rmsResidual / span);
}

/** Above this fraction of the image diagonal, a corner's estimated
 * extrapolation error (`cornerExtrapolationErrorPx`) is worth calling out in
 * `warnings` — purely informational, `scoreConfidence` is what actually acts
 * on the underlying number. Same scale convention as `BORDER_MARGIN_FRACTION`. */
const WARN_CORNER_ERROR_FRACTION = 0.01;

/** The mm-space boundary of a rectified table, in the corner order of
 * `TableDetection.boundary`. Trivially the rectangle itself — `TableGeometry`
 * is by definition post-rectification — but written out so the coordinate
 * convention is stated once, here, rather than assumed at each call site. */
export function rectifiedBoundary(widthMm: number, heightMm: number): [Point, Point, Point, Point] {
  return [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];
}
