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

    const boundary = orderQuadClockwise(corners);
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

    return {
      detection: { boundary, size },
      sides,
      cornersOutOfFrame,
      clothCoverage,
      observedAspectRatio,
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
      return { line, rmsResidual: Infinity, pointCount: pts.length, spanPx: 0 };
    }
    const fit = fitLineTls(pts);
    return {
      line: fit.line,
      rmsResidual: fit.rmsResidual,
      pointCount: pts.length,
      spanPx: spanAlongLine(pts, fit.line),
    };
  });

  return fits as [SideFit, SideFit, SideFit, SideFit];
}

/** Extent of the points projected onto the line's direction, in pixels. */
function spanAlongLine(points: readonly Vec2[], line: Line2): number {
  const dx = -line.b;
  const dy = line.a;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = p.x * dx + p.y * dy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

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
