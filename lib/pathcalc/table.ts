/**
 * Table coordinate model for the Path Calculation engine.
 *
 * ## Coordinate convention (documented per `TableGeometry`'s contract note)
 *
 * `TableGeometry.boundary` is the **cushion nose line** in real-world mm, after
 * homography rectification. This engine reduces it to its axis-aligned
 * bounding box and works in that frame:
 *
 *   - `x` runs along the table's long side, `y` along the short side
 *   - `y` increases "up"; the cushion at `maxY` is `'top'`, at `minY` `'bottom'`
 *   - the origin is wherever the Vision module put it — nothing here assumes 0,0
 *
 * A ball's *centre* can never be closer than one ball radius to the nose line,
 * so all cushion maths happens on the boundary inset by `BALL_RADIUS_MM`.
 */

import type { Point, TableGeometry } from '@/lib/types';
import { EPS } from './geometry';

export interface TableBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  widthMm: number;
  heightMm: number;
  /** Longer of the two sides — the natural unit for stroke-length budgets. */
  longSideMm: number;
}

export type CushionId = 'left' | 'right' | 'top' | 'bottom';

export interface CushionHit {
  /** Distance along the ray at which the ball centre reaches the inset wall. */
  t: number;
  cushion: CushionId;
  /** Unit normal pointing back into the playing area. */
  normal: Point;
}

/**
 * Axis-aligned bounds of the cushion-nose boundary.
 *
 * Uses the AABB of the four corners rather than the exact quadrilateral, so a
 * boundary that is slightly non-rectangular (imperfect rectification) degrades
 * gracefully instead of failing.
 */
export function tableBoundsFromGeometry(table: TableGeometry): TableBounds {
  const xs = table.boundary.map((p) => p.x);
  const ys = table.boundary.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const widthMm = maxX - minX;
  const heightMm = maxY - minY;
  return {
    minX,
    maxX,
    minY,
    maxY,
    widthMm,
    heightMm,
    longSideMm: Math.max(widthMm, heightMm),
  };
}

/**
 * Distance along the ray at which the cue ball's centre first reaches a
 * cushion. The centre is assumed to start inside the inset rectangle; small
 * floating-point excursions are clamped to `t = 0` rather than producing a
 * negative distance.
 */
export function nextCushionHit(
  p: Point,
  dir: Point,
  bounds: TableBounds,
  radiusMm: number,
): CushionHit {
  const minX = bounds.minX + radiusMm;
  const maxX = bounds.maxX - radiusMm;
  const minY = bounds.minY + radiusMm;
  const maxY = bounds.maxY - radiusMm;

  let best = Infinity;
  let cushion: CushionId = 'right';
  let normal: Point = { x: -1, y: 0 };

  const consider = (t: number, id: CushionId, n: Point) => {
    const clamped = Math.max(0, t);
    if (clamped < best) {
      best = clamped;
      cushion = id;
      normal = n;
    }
  };

  if (dir.x > EPS) consider((maxX - p.x) / dir.x, 'right', { x: -1, y: 0 });
  else if (dir.x < -EPS) consider((minX - p.x) / dir.x, 'left', { x: 1, y: 0 });

  if (dir.y > EPS) consider((maxY - p.y) / dir.y, 'top', { x: 0, y: -1 });
  else if (dir.y < -EPS) consider((minY - p.y) / dir.y, 'bottom', { x: 0, y: 1 });

  return { t: best, cushion, normal };
}
