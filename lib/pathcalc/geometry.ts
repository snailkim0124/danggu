/**
 * 2D vector / ray-casting primitives used by the Path Calculation engine.
 *
 * Everything here works in real-world mm table space (`Ball.position`,
 * `TableGeometry.boundary`) and reuses `Point` from the shared contract rather
 * than introducing a parallel vector type.
 */

import type { Point } from '@/lib/types';

export const EPS = 1e-9;

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

export function lengthOf(a: Point): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector, or `{0,0}` for a degenerate input (callers must guard). */
export function normalize(a: Point): Point {
  const l = lengthOf(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function fromAngleRad(rad: number): Point {
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Wrap an angle into [0, 360). */
export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Smallest absolute difference between two angles, in degrees (0..180). */
export function angleGapDeg(a: number, b: number): number {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return d > 180 ? 360 - d : d;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * First forward intersection of the ray `p + t*dir` (dir must be unit length)
 * with the circle of radius `r` centred at `c`, or `null` if the ray misses.
 *
 * Only the *entry* root is returned: if the ray origin is already inside the
 * circle the answer is `null`, because an overlapping ball is handled
 * explicitly by the simulator (frozen / just-contacted balls) rather than by
 * letting the ray exit through the far side.
 */
export function rayCircleHit(
  p: Point,
  dir: Point,
  c: Point,
  r: number,
  tMin = 0,
): number | null {
  const m = sub(p, c);
  const b = dot(m, dir);
  const cc = dot(m, m) - r * r;
  if (cc > 0 && b > 0) return null; // outside and heading away
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= tMin ? t : null;
}

/**
 * Minimum distance from point `c` to the segment `p -> p + dir*maxT`
 * (dir must be unit length). Used to measure how badly a near-miss shot missed.
 */
export function closestApproachToPoint(
  p: Point,
  dir: Point,
  maxT: number,
  c: Point,
): number {
  const t = clamp(dot(sub(c, p), dir), 0, Math.max(0, maxT));
  return distance(add(p, scale(dir, t)), c);
}
