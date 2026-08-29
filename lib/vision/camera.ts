/**
 * Homography, camera-pose recovery and the ball-radius parallax correction.
 *
 * This file is the answer to plan Risk R2 ("공 반지름 시차 미보정"): a ball's
 * centre sits `r` mm *above* the cloth, so mapping its image centroid through
 * the cloth-plane (z=0) homography places it tens of millimetres too far from
 * the camera. Correcting that needs the camera's position in table
 * coordinates, which is what `recoverCameraPose` recovers from the very same
 * homography — no checkerboard, no calibration step, no user input.
 *
 * Coordinate conventions
 * ----------------------
 * Table frame: X along the long cushion (0..widthMm), Y along the short
 * cushion (0..heightMm), Z up out of the cloth. Corner order
 * `[(0,0), (W,0), (W,H), (0,H)]` corresponds to the *counter-clockwise-in-image*
 * ordering, i.e. the reverse of what `orderQuadClockwise` produces. The table
 * plane is y-up (Z out of the cloth) while an image is y-down, so projecting
 * the cloth from a camera above it reverses orientation; `alignQuadToTable`
 * applies that reversal, and getting it backwards yields a camera recovered
 * *below* the cloth. See `alignQuadToTable`.
 *
 * Image frame: pixels, x right, y down, origin at the top-left pixel centre.
 *
 * Everything here is pure TypeScript so it can be tested against a synthetic
 * camera with known ground truth (see `camera.test.ts`) rather than only
 * against real photos.
 */

import { TABLE_DIMENSIONS_MM, type Point, type TableSize } from '@/lib/types';
import {
  type Mat3,
  type Vec2,
  applyHomography,
  distance,
  mat3Inverse,
  mat3Multiply,
  signedPolygonArea,
  solveLinearSystem,
} from './geometry';

// ---------------------------------------------------------------------------
// Homography estimation
// ---------------------------------------------------------------------------

/**
 * The mm-space rectangle a table of the given size maps to, in the corner
 * order documented above.
 *
 * `cushionWidthMm` (default `0`, reproducing the exact cushion-nose rectangle
 * as before) expands the rectangle outward on every side. This exists because
 * `detectTableBoundary` cannot tell the cushion nose (where balls actually
 * roll and bounce) apart from the cloth-covered rail beyond it by colour —
 * both are cut from the same cloth, so the segmented contour's outer edge is
 * really the *outer rail edge*, a real, fixed distance further out than the
 * nose line. Passing that distance here and treating the detected quad as the
 * outer-rail rectangle (rather than as the nose line itself) means the
 * resulting `TableFrame`'s own `(0,0)..(widthMm,heightMm)` — used everywhere
 * else in the app — is the true nose line, with no change needed anywhere
 * downstream. See `lib/vision/constants.ts#CUSHION_WIDTH_MM`.
 */
export function tableRectMm(size: TableSize, cushionWidthMm = 0): [Point, Point, Point, Point] {
  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[size];
  const c = cushionWidthMm;
  return [
    { x: -c, y: -c },
    { x: widthMm + c, y: -c },
    { x: widthMm + c, y: heightMm + c },
    { x: -c, y: heightMm + c },
  ];
}

interface Normalisation {
  transform: Mat3;
  points: Vec2[];
}

/**
 * Hartley isotropic normalisation: translate to the centroid and scale so the
 * mean distance from the origin is √2. Without this the DLT system mixes
 * terms of order 1 with terms of order 2540·1600 ≈ 4e6 and loses most of its
 * precision — which is exactly the regime we're in (mm coordinates up to 2540
 * against pixel coordinates up to 1600).
 */
function normalisePoints(points: readonly Vec2[]): Normalisation {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let meanDist = 0;
  for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= points.length;
  const s = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1;

  return {
    transform: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    points: points.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

/**
 * Exact 4-point DLT homography, `src → dst`.
 *
 * We only ever have 4 correspondences (the four table corners), so this is an
 * exactly-determined 8x8 solve rather than an over-determined SVD problem —
 * which is why OpenCV's `findHomography` (and its RANSAC machinery) buys us
 * nothing here and is skipped in favour of code we can test directly.
 */
export function computeHomography(
  src: readonly [Vec2, Vec2, Vec2, Vec2],
  dst: readonly [Vec2, Vec2, Vec2, Vec2]
): Mat3 {
  const ns = normalisePoints(src);
  const nd = normalisePoints(dst);

  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = ns.points[i];
    const { x: u, y: v } = nd.points[i];
    a.push(x, y, 1, 0, 0, 0, -u * x, -u * y);
    b.push(u);
    a.push(0, 0, 0, x, y, 1, -v * x, -v * y);
    b.push(v);
  }
  const h = solveLinearSystem(a, b, 8);
  const hNorm: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];

  // Undo the normalisation: H = T_dst⁻¹ · H_norm · T_src
  return mat3Multiply(mat3Inverse(nd.transform), mat3Multiply(hNorm, ns.transform));
}

// ---------------------------------------------------------------------------
// Intrinsics
// ---------------------------------------------------------------------------

export interface Intrinsics {
  /** Focal length in pixels (square pixels assumed). */
  focalPx: number;
  principalPoint: Vec2;
  /**
   * How the focal length was obtained:
   * - `measured`: solved from this photo's own homography constraints.
   * - `assumed`: the view is too close to frontoparallel for the constraints
   *   to determine a focal length at all, so a typical phone value was
   *   substituted. Recognition still works and the parallax correction is
   *   small in that geometry anyway; it is reported rather than hidden so the
   *   confidence score can take the penalty.
   */
  source: 'measured' | 'assumed';
}

/**
 * Typical rear-camera focal length for a phone, expressed as a multiple of the
 * image's larger dimension. ~1.2·maxDim corresponds to roughly a 45° horizontal
 * field of view, which is close to the common 26mm-equivalent main camera.
 */
const ASSUMED_FOCAL_RATIO = 1.2;

/**
 * How well the homography holds up as "this quad is a rectangle of exactly
 * these proportions, seen through a normal camera", in 0..1.
 *
 * Method: `K⁻¹H` must have the form `λ[r1 r2 t]` with `r1`, `r2` orthonormal.
 * That gives two scale-invariant residuals at any trial focal length `f`:
 *
 *   e₁ = cos∠(u, v)      — must be 0 (perpendicular)
 *   e₂ = ln(|u| / |v|)   — must be 0 (equal length)
 *
 * where `u`, `v` are the first two columns of `K⁻¹H`. We search for the `f`
 * minimising `e₁² + e₂²`. If the quad really is the claimed rectangle, some
 * focal length drives both to ~0. If the corners were mis-assigned (long
 * cushion mapped to short), no `f` can satisfy both at once, and the residual
 * stays large.
 *
 * Solving *jointly* for `f` matters. Solving each constraint separately for
 * `f` and comparing the answers looks equivalent but is not: on a photo taken
 * down the length of the table one of the two constraints is numerically dead
 * (its denominator is ~0), so it returns noise, and the comparison then reads
 * a perfectly good quad as a wild disagreement — including the ground-truth
 * one. Both residuals here are dimensionless ratios, so an insensitive
 * constraint simply contributes a flat, small term instead of garbage.
 *
 * This also replaces comparing the quad's *image-space* aspect ratio to 2:1,
 * which is far too weak to be useful: perspective legitimately drives that
 * ratio anywhere from ~1.0 to ~2.5 on real playing-angle photos, so any
 * tolerance loose enough to avoid false alarms is too loose to catch anything.
 */
export function rectangleConsistency(
  tableToImage: Mat3,
  imageWidth: number,
  imageHeight: number
): number {
  const { residual } = fitFocalJointly(tableToImage, imageWidth, imageHeight);
  // A combined residual of 0.05 (≈3° out of square) scores ~0.6; 0.2 scores ~0.02.
  return Math.exp(-((residual / 0.062) ** 2));
}

interface JointFocalFit {
  focalPx: number;
  /** sqrt(e₁² + e₂²) at the optimum — dimensionless, 0 is perfect. */
  residual: number;
  /**
   * How much worse the fit gets at half and double the optimal focal length.
   * Near zero means the photo simply does not constrain the focal length.
   */
  curvature: number;
}

/**
 * Find the focal length that best satisfies both orthonormality constraints,
 * by a coarse scan over log-focal followed by golden-section refinement.
 * The objective is smooth and unimodal in practice over the plausible range.
 */
function fitFocalJointly(
  tableToImage: Mat3,
  imageWidth: number,
  imageHeight: number
): JointFocalFit {
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const a1 = tableToImage[0] - cx * tableToImage[6];
  const b1 = tableToImage[3] - cy * tableToImage[6];
  const c1 = tableToImage[6];
  const a2 = tableToImage[1] - cx * tableToImage[7];
  const b2 = tableToImage[4] - cy * tableToImage[7];
  const c2 = tableToImage[7];

  const objective = (f: number): number => {
    const u = [a1 / f, b1 / f, c1];
    const v = [a2 / f, b2 / f, c2];
    const nu = Math.hypot(u[0], u[1], u[2]);
    const nv = Math.hypot(v[0], v[1], v[2]);
    if (!(nu > 1e-15) || !(nv > 1e-15)) return Infinity;
    const e1 = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
    const e2 = Math.log(nu / nv);
    return e1 * e1 + e2 * e2;
  };

  const maxDim = Math.max(imageWidth, imageHeight);
  let lo = Math.log(0.25 * maxDim);
  let hi = Math.log(8 * maxDim);

  let bestLog = lo;
  let bestVal = Infinity;
  const STEPS = 96;
  for (let i = 0; i <= STEPS; i++) {
    const t = lo + ((hi - lo) * i) / STEPS;
    const val = objective(Math.exp(t));
    if (val < bestVal) {
      bestVal = val;
      bestLog = t;
    }
  }

  // Refine around the coarse minimum.
  const step = (hi - lo) / STEPS;
  lo = bestLog - step;
  hi = bestLog + step;
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40; i++) {
    const m1 = hi - phi * (hi - lo);
    const m2 = lo + phi * (hi - lo);
    if (objective(Math.exp(m1)) < objective(Math.exp(m2))) hi = m2;
    else lo = m1;
  }
  const focalPx = Math.exp((lo + hi) / 2);
  const best = objective(focalPx);
  const spread = Math.min(objective(focalPx * 2), objective(focalPx / 2)) - best;
  return {
    focalPx,
    residual: Math.sqrt(Math.max(0, best)),
    curvature: Number.isFinite(spread) ? spread : 0,
  };
}

/**
 * Recover the camera's focal length from the table homography.
 *
 * Uses the same joint fit as `rectangleConsistency` rather than either
 * closed-form constraint alone, because whichever constraint happens to be
 * ill-conditioned for a given camera angle returns numerical noise, and there
 * is no way to tell in advance which one that will be.
 *
 * A frontoparallel view determines nothing: the objective is then flat in `f`,
 * and the optimum found is meaningless. That is detected by checking the
 * objective actually has curvature around its minimum — if halving or doubling
 * the focal length barely changes the fit, the estimate is discarded in favour
 * of a typical phone value and flagged as `assumed`.
 */
export function estimateIntrinsics(
  tableToImage: Mat3,
  imageWidth: number,
  imageHeight: number
): Intrinsics {
  const principalPoint: Vec2 = { x: imageWidth / 2, y: imageHeight / 2 };
  const assumed: Intrinsics = {
    focalPx: ASSUMED_FOCAL_RATIO * Math.max(imageWidth, imageHeight),
    principalPoint,
    source: 'assumed',
  };

  const fit = fitFocalJointly(tableToImage, imageWidth, imageHeight);
  if (!Number.isFinite(fit.focalPx) || !(fit.focalPx > 0)) return assumed;

  const maxDim = Math.max(imageWidth, imageHeight);
  if (fit.focalPx <= 0.25 * maxDim * 1.001 || fit.focalPx >= 8 * maxDim * 0.999) {
    // Pinned to a search bound: the minimum is outside any plausible camera.
    return assumed;
  }
  if (fit.curvature < 1e-4) return assumed;

  return { focalPx: fit.focalPx, principalPoint, source: 'measured' };
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

export interface CameraPose {
  intrinsics: Intrinsics;
  /** Rotation, table frame → camera frame. Row-major 3x3. */
  rotation: readonly number[];
  /** Translation, table frame → camera frame, in mm. */
  translation: readonly [number, number, number];
  /**
   * Camera centre expressed in **table** coordinates (mm). `z` is the height
   * above the cloth. This is the single value the parallax correction needs.
   */
  centerMm: { x: number; y: number; z: number };
}

/**
 * Decompose a plane→image homography into a camera pose, given intrinsics.
 *
 * Standard construction: `K⁻¹H = λ[r1 r2 t]`; recover `λ` from `|r1| = |r2| = 1`,
 * re-orthonormalise `r1`/`r2` (the estimate is noisy so they are only
 * approximately orthonormal), and set `r3 = r1 × r2`. The sign is fixed by
 * requiring the table to lie *in front of* the camera (`t_z > 0`).
 *
 * This is not a full bundle-adjusted 6-DOF solve — with one plane and four
 * points there is nothing more to extract — but it is an exact closed form
 * given the intrinsics, not an approximation.
 */
export function recoverCameraPose(tableToImage: Mat3, intrinsics: Intrinsics): CameraPose {
  const { focalPx: f, principalPoint } = intrinsics;

  // K⁻¹ · H, computed column-wise.
  const kInvCol = (h0: number, h1: number, h2: number): [number, number, number] => [
    (h0 - principalPoint.x * h2) / f,
    (h1 - principalPoint.y * h2) / f,
    h2,
  ];
  let col1 = kInvCol(tableToImage[0], tableToImage[3], tableToImage[6]);
  let col2 = kInvCol(tableToImage[1], tableToImage[4], tableToImage[7]);
  let col3 = kInvCol(tableToImage[2], tableToImage[5], tableToImage[8]);

  const n1 = Math.hypot(col1[0], col1[1], col1[2]);
  const n2 = Math.hypot(col2[0], col2[1], col2[2]);
  if (!(n1 > 1e-12) || !(n2 > 1e-12)) {
    throw new Error('recoverCameraPose: degenerate homography');
  }
  let lambda = (n1 + n2) / 2;

  // The table must be in front of the camera: t_z > 0.
  if (col3[2] < 0) lambda = -lambda;

  col1 = [col1[0] / lambda, col1[1] / lambda, col1[2] / lambda];
  col2 = [col2[0] / lambda, col2[1] / lambda, col2[2] / lambda];
  col3 = [col3[0] / lambda, col3[1] / lambda, col3[2] / lambda];

  // Re-orthonormalise r1, r2 (symmetric Gram-Schmidt: split the error evenly
  // rather than privileging r1).
  const dot12 = col1[0] * col2[0] + col1[1] * col2[1] + col1[2] * col2[2];
  const r1raw: [number, number, number] = [
    col1[0] - (dot12 / 2) * col2[0],
    col1[1] - (dot12 / 2) * col2[1],
    col1[2] - (dot12 / 2) * col2[2],
  ];
  const r2raw: [number, number, number] = [
    col2[0] - (dot12 / 2) * col1[0],
    col2[1] - (dot12 / 2) * col1[1],
    col2[2] - (dot12 / 2) * col1[2],
  ];
  const r1 = unit(r1raw);
  const r2 = unit(r2raw);
  const r3: [number, number, number] = [
    r1[1] * r2[2] - r1[2] * r2[1],
    r1[2] * r2[0] - r1[0] * r2[2],
    r1[0] * r2[1] - r1[1] * r2[0],
  ];

  // Rotation matrix, table → camera. Columns are r1, r2, r3.
  const rotation = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  const translation: [number, number, number] = [col3[0], col3[1], col3[2]];

  // Camera centre in table coordinates: C = -Rᵀ t.
  const centerMm = {
    x: -(rotation[0] * translation[0] + rotation[3] * translation[1] + rotation[6] * translation[2]),
    y: -(rotation[1] * translation[0] + rotation[4] * translation[1] + rotation[7] * translation[2]),
    z: -(rotation[2] * translation[0] + rotation[5] * translation[1] + rotation[8] * translation[2]),
  };

  return { intrinsics, rotation, translation, centerMm };
}

function unit(v: [number, number, number]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-12) throw new Error('unit: zero-length vector');
  return [v[0] / n, v[1] / n, v[2] / n];
}

// ---------------------------------------------------------------------------
// The parallax correction (plan Risk R2)
// ---------------------------------------------------------------------------

/**
 * Correct a ball position for the fact that its centre is `ballRadiusMm`
 * above the cloth.
 *
 * `clothPointMm` is where the ball's image centroid lands when it is pushed
 * through the z=0 homography — i.e. where the viewing ray pierces the cloth.
 * The ball's actual centre is on that same ray, but at height z = r. Walking
 * back along the ray from the camera centre `C`:
 *
 *   P(t) = C + t·(P₀ − C),   P(t)_z = r  ⇒  t = (C_z − r) / C_z
 *
 * The resulting shift is ≈ r · (horizontal distance from camera) / C_z, which
 * for a phone held ~700mm above the cloth looking at a ball ~1.8m away is
 * ~79mm — squarely in the 60-90mm band the plan warns about, and equivalent to
 * more than a whole ball's width of aiming error.
 *
 * Degenerate case: a camera at or below the ball-centre plane (`C_z ≤ r`)
 * cannot see the cloth under the ball at all; the ray never reaches z=r going
 * forwards. That is not a recoverable geometry, so it throws rather than
 * silently returning a wrong number.
 */
export function reprojectToBallPlane(
  clothPointMm: Point,
  cameraCenterMm: { x: number; y: number; z: number },
  ballRadiusMm: number
): Point {
  const cz = cameraCenterMm.z;
  if (!(cz > ballRadiusMm)) {
    throw new Error(
      `reprojectToBallPlane: camera height (${cz.toFixed(1)}mm) is not above the ` +
        `ball-centre plane (${ballRadiusMm}mm); the recovered pose is unusable`
    );
  }
  const t = (cz - ballRadiusMm) / cz;
  return {
    x: cameraCenterMm.x + t * (clothPointMm.x - cameraCenterMm.x),
    y: cameraCenterMm.y + t * (clothPointMm.y - cameraCenterMm.y),
  };
}

// ---------------------------------------------------------------------------
// Bundled table-frame transform
// ---------------------------------------------------------------------------

/**
 * Everything downstream needs to move between image pixels and table
 * millimetres, plus the pose required to undo the ball parallax.
 */
export interface TableFrame {
  size: TableSize;
  widthMm: number;
  heightMm: number;
  /** Image pixels → cloth-plane mm. */
  imageToTable: Mat3;
  /** Cloth-plane mm → image pixels. */
  tableToImage: Mat3;
  pose: CameraPose;
  /**
   * 0..1 agreement between the two independent focal-length constraints — how
   * well the detected quad holds up as "a rectangle of exactly these
   * proportions". Feeds the confidence score; see `rectangleConsistency`.
   */
  rectangleConsistency: number;
}

/**
 * Rotate/reverse a detected image quad so its corners correspond to
 * `tableRectMm`'s corners.
 *
 * `orderQuadClockwise` fixes the *winding* but starts at whichever vertex is
 * nearest the image origin, which is an accident of where the camera stood. If
 * that start corner is off by one, a 2540x1270 table gets mapped onto a
 * 1270x2540 rectangle and every derived quantity — scale, pose, ball positions
 * — is wrong by a 90° rotation, while still looking like a well-formed
 * homography. Two corrections are applied:
 *
 *   1. **Winding.** The image quad must wind *opposite* to the mm rectangle.
 *      This is not arbitrary: the table frame is y-up (Z out of the cloth)
 *      while an image is y-down, so projecting the cloth plane from a camera
 *      above it is orientation-*reversing* in the 2D signed-area sense. Feed
 *      in a same-winding correspondence and the decomposition has to pick a
 *      mirrored solution, which comes back as a camera *below* the cloth
 *      (negative height) and a parallax correction pointing the wrong way.
 *      `orderQuadClockwise` normalises detections to clockwise-in-image, which
 *      is positive-area, so this reversal is the common path, not an edge case.
 *   2. **Long-axis alignment.** Of the two remaining rotations, the one whose
 *      homography is more self-consistent as a rectangle wins
 *      (`rectangleConsistency`). Comparing image-space side lengths instead —
 *      "the longer pair must be the long cushions" — is unreliable exactly
 *      where it matters: a low camera sighting down the length of the table
 *      foreshortens the long cushions so hard that they can measure *shorter*
 *      in pixels than the near short cushion, and the naive test then rotates
 *      the whole table frame by 90°. Side lengths are kept only as a
 *      tie-break for when both rotations are equally (in)consistent.
 *
 * The residual 180° ambiguity is left alone: a billiard table is symmetric
 * under it, so both answers describe the same physical layout, and picking
 * deterministically keeps repeated runs stable.
 */
/**
 * @param forceRotation Skip the automatic long/short-axis scoring and use
 * this rotation directly (still after the winding fix). Exists for the
 * "가로/세로 바꾸기" manual override on the confirm screen: the automatic
 * orthonormality test this function otherwise runs is provably unreliable on
 * some real photos — specifically the "looking down the length of the table"
 * angle this module's own docs already call out, where one of the two joint
 * focal-length constraints goes numerically dead and can score the *correct*
 * orientation near zero while the wrong one looks confidently self-consistent
 * (`rectangleConsistency` has no way to tell that apart from a genuinely bad
 * quad). Rather than chase a fully robust replacement test, the app instead
 * lets the user flip the result directly when they know better — see
 * `swapTableOrientation` in this module.
 */
export function alignQuadToTable(
  imageQuad: readonly [Vec2, Vec2, Vec2, Vec2],
  mmQuad: readonly [Vec2, Vec2, Vec2, Vec2],
  imageWidth: number,
  imageHeight: number,
  forceRotation?: 0 | 1
): [Vec2, Vec2, Vec2, Vec2] {
  let quad: Vec2[] = [...imageQuad];
  if (signedPolygonArea(quad) * signedPolygonArea(mmQuad) > 0) {
    quad = [...quad].reverse();
  }

  const rotate = (r: number): [Vec2, Vec2, Vec2, Vec2] => [
    quad[r % 4],
    quad[(r + 1) % 4],
    quad[(r + 2) % 4],
    quad[(r + 3) % 4],
  ];

  if (forceRotation !== undefined) return rotate(forceRotation);

  const sideLength = (q: readonly Vec2[], i: number) => distance(q[i], q[(i + 1) % 4]);
  const pairSum = (q: readonly Vec2[], i: number) => sideLength(q, i) + sideLength(q, i + 2);

  let best: [Vec2, Vec2, Vec2, Vec2] | null = null;
  let bestScore = -Infinity;
  for (const r of [0, 1]) {
    const candidate = rotate(r);
    let score: number;
    try {
      score = rectangleConsistency(
        computeHomography(mmQuad, candidate),
        imageWidth,
        imageHeight
      );
    } catch {
      // A degenerate quad for this rotation is itself evidence against it.
      score = 0;
    }
    // Tiny tie-break so a dead heat still resolves to the long-side match.
    score += pairSum(candidate, 0) >= pairSum(candidate, 1) ? 1e-6 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) throw new Error('alignQuadToTable: no usable corner assignment');
  return best;
}

export function buildTableFrame(
  imageQuad: readonly [Vec2, Vec2, Vec2, Vec2],
  size: TableSize,
  imageWidth: number,
  imageHeight: number,
  forceRotation?: 0 | 1,
  /** See `tableRectMm` — pass this when `imageQuad` is the outer-rail edge
   * (e.g. straight from `detectTableBoundary`) rather than the cushion-nose
   * line itself. Defaults to `0` (no correction), matching every existing
   * caller that already has a nose-line quad (a user-corrected one, or a
   * synthetic test rig built directly from `tableRectMm(size)`). */
  cushionWidthMm = 0
): TableFrame {
  const mmQuad = tableRectMm(size, cushionWidthMm);
  const aligned = alignQuadToTable(imageQuad, mmQuad, imageWidth, imageHeight, forceRotation);
  const tableToImage = computeHomography(mmQuad, aligned);
  const imageToTable = mat3Inverse(tableToImage);
  const intrinsics = estimateIntrinsics(tableToImage, imageWidth, imageHeight);
  const pose = recoverCameraPose(tableToImage, intrinsics);
  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[size];
  return {
    size,
    widthMm,
    heightMm,
    imageToTable,
    tableToImage,
    pose,
    rectangleConsistency: rectangleConsistency(tableToImage, imageWidth, imageHeight),
  };
}

/**
 * Full image→table mapping for a ball centroid, including the z=r parallax
 * correction. This is the only function ball detection should use to produce
 * a `Ball.position`.
 */
export function ballImagePointToTableMm(
  frame: TableFrame,
  imagePoint: Vec2,
  ballRadiusMm: number
): Point {
  const onCloth = applyHomography(frame.imageToTable, imagePoint);
  return reprojectToBallPlane(onCloth, frame.pose.centerMm, ballRadiusMm);
}

/**
 * Local scale of the image→table map at an image point, in mm per pixel.
 *
 * Used to predict how large a ball *should* look at a given place in the
 * photo. Under perspective this varies by a factor of 2-3 across one frame, so
 * a fixed pixel-radius filter would either miss far balls or admit near-field
 * junk; deriving the expected radius from the homography instead makes the
 * filter scale-correct everywhere.
 *
 * The value returned is `√|det J|` — the *area* scale, not the mean of the two
 * axis scales. Under an oblique view a ball images as an ellipse whose two
 * semi-axes differ substantially (foreshortening along the viewing direction),
 * and the area-equivalent radius is the one number that matches the blob a
 * contour fit actually produces. Averaging the axis scales instead would bias
 * the prediction towards the un-foreshortened axis and reject perfectly good
 * balls in steeply-angled photos.
 */
export function localMmPerPixel(frame: TableFrame, imagePoint: Vec2): number {
  const eps = 1;
  const p0 = applyHomography(frame.imageToTable, imagePoint);
  const px = applyHomography(frame.imageToTable, { x: imagePoint.x + eps, y: imagePoint.y });
  const py = applyHomography(frame.imageToTable, { x: imagePoint.x, y: imagePoint.y + eps });
  const jx = { x: (px.x - p0.x) / eps, y: (px.y - p0.y) / eps };
  const jy = { x: (py.x - p0.x) / eps, y: (py.y - p0.y) / eps };
  const areaScale = Math.abs(jx.x * jy.y - jx.y * jy.x);
  return Math.sqrt(areaScale);
}

/**
 * Radius, in image pixels, that a ball at the given image location should
 * appear to have.
 *
 * A **sphere** projects to (very nearly) a circle of radius `f·r/d`, where `d`
 * is the 3D distance from the camera to the ball's centre. It does *not*
 * project to the foreshortened ellipse you would get from a flat disc lying on
 * the table — a sphere looks the same from every direction, so there is
 * nothing to foreshorten. Deriving the expected size from the plane's local
 * scale (`localMmPerPixel`) instead gets this badly wrong: at the far end of an
 * oblique photo the plane is compressed ~2.5x along the viewing direction, so
 * a plane-based prediction undershoots a real ball by nearly a factor of two
 * and the size filter rejects it.
 *
 * The exact silhouette radius is `f·r/√(d²−r²)`; with `d` on the order of
 * metres and `r` ≈ 30mm the difference is under 0.1%, so the simple form is
 * used.
 */
export function expectedBallRadiusPx(
  frame: TableFrame,
  imagePoint: Vec2,
  ballRadiusMm: number
): number {
  const ballXy = ballImagePointToTableMm(frame, imagePoint, ballRadiusMm);
  const c = frame.pose.centerMm;
  const distanceMm = Math.hypot(ballXy.x - c.x, ballXy.y - c.y, ballRadiusMm - c.z);
  if (!(distanceMm > 1e-6)) return 0;
  return (frame.pose.intrinsics.focalPx * ballRadiusMm) / distanceMm;
}

/** Project a table-frame point at height `zMm` into the image. */
export function projectTablePoint(frame: TableFrame, pointMm: Point, zMm: number): Vec2 {
  const { rotation: r, translation: t, intrinsics } = frame.pose;
  const xc = r[0] * pointMm.x + r[1] * pointMm.y + r[2] * zMm + t[0];
  const yc = r[3] * pointMm.x + r[4] * pointMm.y + r[5] * zMm + t[1];
  const zc = r[6] * pointMm.x + r[7] * pointMm.y + r[8] * zMm + t[2];
  if (!(zc > 1e-9)) throw new Error('projectTablePoint: point is behind the camera');
  return {
    x: intrinsics.focalPx * (xc / zc) + intrinsics.principalPoint.x,
    y: intrinsics.focalPx * (yc / zc) + intrinsics.principalPoint.y,
  };
}
