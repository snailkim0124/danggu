/**
 * Pure-TypeScript 2D geometry primitives for the Vision Recognition module.
 *
 * Deliberately free of any OpenCV dependency: everything here is
 * deterministic, unit-testable maths. OpenCV.js is used only for the
 * pixel-level work (colour conversion, masking, morphology, contours) —
 * see `table.ts` / `balls.ts`. Keeping the geometry here means the parts
 * most likely to be *silently wrong* (homography, line intersection, pose)
 * can be tested without loading a WASM blob or synthesising an image.
 */

import type { Point } from '@/lib/types';

export type Vec2 = Point;

/** 3x3 matrix, row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Mat3 = readonly number[];

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (z-component of the 3D cross product). */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function norm(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroid(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

// ---------------------------------------------------------------------------
// 3x3 matrices / projective transforms
// ---------------------------------------------------------------------------

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function mat3Inverse(m: Mat3): Mat3 {
  const det = mat3Determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('mat3Inverse: matrix is singular or non-finite');
  }
  const inv = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * inv,
    (m[2] * m[7] - m[1] * m[8]) * inv,
    (m[1] * m[5] - m[2] * m[4]) * inv,
    (m[5] * m[6] - m[3] * m[8]) * inv,
    (m[0] * m[8] - m[2] * m[6]) * inv,
    (m[2] * m[3] - m[0] * m[5]) * inv,
    (m[3] * m[7] - m[4] * m[6]) * inv,
    (m[1] * m[6] - m[0] * m[7]) * inv,
    (m[0] * m[4] - m[1] * m[3]) * inv,
  ];
}

/** Apply a projective transform to a 2D point (homogeneous divide included). */
export function applyHomography(h: Mat3, p: Vec2): Vec2 {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-12) {
    throw new Error('applyHomography: point maps to the line at infinity');
  }
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * A line in normalised implicit form `a*x + b*y + c = 0` with `a² + b² = 1`,
 * so `a*x + b*y + c` is directly the signed perpendicular distance from
 * (x, y) to the line. This form is used (rather than two endpoints) precisely
 * because the plan requires the table corners to be recoverable when the
 * corner itself is outside the frame — an infinite line has no endpoints to
 * lose.
 */
export interface Line2 {
  a: number;
  b: number;
  c: number;
}

export function lineThroughPoints(p: Vec2, q: Vec2): Line2 {
  const d = sub(q, p);
  const len = norm(d);
  if (len < 1e-12) throw new Error('lineThroughPoints: coincident points');
  // Normal is the direction rotated 90°.
  const a = -d.y / len;
  const b = d.x / len;
  return { a, b, c: -(a * p.x + b * p.y) };
}

/** Signed perpendicular distance from `p` to `line` (sign = which side). */
export function signedDistanceToLine(line: Line2, p: Vec2): number {
  return line.a * p.x + line.b * p.y + line.c;
}

export function distanceToLine(line: Line2, p: Vec2): number {
  return Math.abs(signedDistanceToLine(line, p));
}

/** Unit direction vector along the line. */
export function lineDirection(line: Line2): Vec2 {
  return { x: -line.b, y: line.a };
}

/**
 * Intersection of two lines, or `null` if they are (near-)parallel.
 * `minSinAngle` rejects grazing intersections whose position is numerically
 * meaningless — for table sides we expect near-90° crossings, so anything
 * below ~5° is a detection failure, not a corner.
 */
export function lineIntersection(l1: Line2, l2: Line2, minSinAngle = 0.087): Vec2 | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  // Both normals are unit vectors, so |det| is exactly |sin(angle between lines)|.
  if (Math.abs(det) < minSinAngle) return null;
  return {
    x: (l1.b * l2.c - l2.b * l1.c) / det,
    y: (l2.a * l1.c - l1.a * l2.c) / det,
  };
}

export interface LineFit {
  line: Line2;
  /** RMS perpendicular residual of the input points, in input units (px). */
  rmsResidual: number;
  /** Number of points the fit was computed from. */
  count: number;
}

/**
 * Total-least-squares (orthogonal / Deming) line fit.
 *
 * Ordinary least squares minimises vertical residuals and therefore blows up
 * on near-vertical cushion edges; TLS minimises perpendicular distance and is
 * orientation-independent, which matters because a table photographed at an
 * angle has sides at arbitrary orientations.
 *
 * Implemented via the 2x2 scatter matrix's minor eigenvector (the direction of
 * least variance is the line's normal).
 */
export function fitLineTls(points: readonly Vec2[]): LineFit {
  if (points.length < 2) {
    throw new Error('fitLineTls: need at least 2 points');
  }
  const c = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const n = points.length;
  sxx /= n;
  sxy /= n;
  syy /= n;

  // Eigenvalues of [[sxx, sxy], [sxy, syy]].
  const mean = (sxx + syy) / 2;
  const diff = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const lambdaMin = mean - diff;

  // Eigenvector for lambdaMin is the line's normal.
  let nx = sxy;
  let ny = lambdaMin - sxx;
  let len = Math.hypot(nx, ny);
  if (len < 1e-12) {
    // Degenerate (isotropic) scatter — fall back to the other eigenvector form.
    nx = lambdaMin - syy;
    ny = sxy;
    len = Math.hypot(nx, ny);
  }
  if (len < 1e-12) {
    // Truly isotropic: no meaningful direction. Pick the x-axis normal.
    nx = 0;
    ny = 1;
    len = 1;
  }
  const a = nx / len;
  const b = ny / len;
  const line: Line2 = { a, b, c: -(a * c.x + b * c.y) };

  let sse = 0;
  for (const p of points) {
    const d = signedDistanceToLine(line, p);
    sse += d * d;
  }
  return { line, rmsResidual: Math.sqrt(sse / n), count: n };
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

/** Signed area; positive when the vertices wind counter-clockwise in a y-up
 * frame (= clockwise in an image's y-down frame). */
export function signedPolygonArea(poly: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += cross(p, q);
  }
  return sum / 2;
}

export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(signedPolygonArea(poly));
}

/**
 * Order 4 points clockwise **in image coordinates** (x right, y down),
 * starting from the point closest to the image origin.
 *
 * This is the ordering `TableDetection.boundary` documents
 * ("[topLeft, topRight, bottomRight, bottomLeft], clockwise from the camera's
 * perspective"), and it is what makes the image↔mm corner correspondence
 * orientation-preserving — see `camera.ts`.
 */
export function orderQuadClockwise(points: readonly Vec2[]): [Vec2, Vec2, Vec2, Vec2] {
  if (points.length !== 4) throw new Error('orderQuadClockwise: expected exactly 4 points');
  const c = centroid(points);
  // atan2(y, x) with y pointing *down* increases clockwise on screen.
  const sorted = [...points].sort(
    (p, q) => Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(q.y - c.y, q.x - c.x)
  );
  // Rotate so the vertex nearest the image origin comes first.
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return [
    sorted[best],
    sorted[(best + 1) % 4],
    sorted[(best + 2) % 4],
    sorted[(best + 3) % 4],
  ];
}

/** Point-in-polygon by ray casting. Works for any simple polygon. */
export function pointInPolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    const intersects =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Shrink a convex polygon towards its centroid by `factor` (0..1, where
 * 0 = unchanged). Used to keep sampling away from cushion edges/shadows.
 */
export function shrinkPolygon(poly: readonly Vec2[], factor: number): Vec2[] {
  const c = centroid(poly);
  return poly.map((p) => add(c, scale(sub(p, c), 1 - factor)));
}

// ---------------------------------------------------------------------------
// Robust circle fitting
// ---------------------------------------------------------------------------

export interface CircleFit {
  center: Vec2;
  radius: number;
  /** RMS radial residual, in input units (px). */
  rmsResidual: number;
  /** Points retained after trimming. */
  inlierCount: number;
}

/**
 * Kåsa algebraic circle fit with iterative trimming.
 *
 * Ball contours are systematically contaminated on one side: the ball's cast
 * shadow is also "not cloth", so it gets swallowed into the same blob and
 * drags a plain centroid several millimetres off. Trimming the worst-residual
 * quartile for a couple of rounds removes the shadow lobe while keeping the
 * clean circular arc, which is the part that actually locates the ball.
 */
export function fitCircleRobust(points: readonly Vec2[], trimRounds = 2): CircleFit {
  if (points.length < 3) throw new Error('fitCircleRobust: need at least 3 points');
  let working = [...points];
  let fit = kasaFit(working);
  for (let round = 0; round < trimRounds; round++) {
    if (working.length < 12) break;
    const withResidual = working
      .map((p) => ({ p, r: Math.abs(distance(p, fit.center) - fit.radius) }))
      .sort((u, v) => u.r - v.r);
    const keep = Math.max(8, Math.floor(withResidual.length * 0.75));
    working = withResidual.slice(0, keep).map((e) => e.p);
    fit = kasaFit(working);
  }
  return fit;
}

function kasaFit(points: readonly Vec2[]): CircleFit {
  // Solve min ||A z - b|| for z = [2cx, 2cy, r² - cx² - cy²] with
  // A = [x, y, 1], b = x² + y². Normal equations on a 3x3 system.
  const c = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (const p of points) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * z;
    syz += y * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) {
    throw new Error('kasaFit: degenerate (collinear) point set');
  }
  const ux = (sxz * syy - syz * sxy) / (2 * det);
  const uy = (syz * sxx - sxz * sxy) / (2 * det);
  const center = { x: c.x + ux, y: c.y + uy };

  let sumR = 0;
  for (const p of points) sumR += distance(p, center);
  const radius = sumR / points.length;

  let sse = 0;
  for (const p of points) {
    const d = distance(p, center) - radius;
    sse += d * d;
  }
  return {
    center,
    radius,
    rmsResidual: Math.sqrt(sse / points.length),
    inlierCount: points.length,
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Solve a dense linear system `A x = b` by Gaussian elimination with partial
 * pivoting. `a` is row-major n x n; mutated in place.
 */
export function solveLinearSystem(a: number[], b: number[], n: number): number[] {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r * n + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) throw new Error('solveLinearSystem: singular matrix');
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k];
        a[col * n + k] = a[pivot * n + k];
        a[pivot * n + k] = t;
      }
      const t = b[col];
      b[col] = b[pivot];
      b[pivot] = t;
    }
    const diag = a[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col] / diag;
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[r * n + k] -= f * a[col * n + k];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= a[r * n + k] * x[k];
    x[r] = s / a[r * n + r];
  }
  return x;
}
