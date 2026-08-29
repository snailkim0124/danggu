/**
 * Rail sight/diamond marker positions for the results diagram (문제점 #3:
 * the reconstructed table diagram was missing the dots real carom tables have
 * along each rail — used as aiming references, especially for bank shots).
 *
 * Frontend-local, presentation-only — not part of the shared `lib/types.ts`
 * contract.
 */

import type { Point } from '@/lib/types';

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Evenly-spaced marker points along all four rails of a table boundary,
 * matching the standard carom-table "diamond system": each long rail divided
 * into `divisionsLong` equal sections (default 8), each short rail into
 * `divisionsShort` (default 4) — the long-standing convention real tables use
 * (visible as small inlaid dots in the reference photos this app was built
 * against), not a measured count from any specific table.
 *
 * Long vs. short is determined per opposite-edge *pair* (edges 0↔2 and 1↔3 of
 * the boundary quad), not per single edge — a perspective-rectified
 * `TableGeometry` boundary should already be a clean rectangle, but comparing
 * pairs keeps this correct even for a slightly non-rectangular boundary
 * (imperfect rectification), where one edge of a pair could measure a hair
 * longer/shorter than its opposite.
 *
 * Returns the four corners plus every interior division point — corners are
 * included exactly once each (not once per adjacent edge).
 */
export function railMarkerPoints(
  boundary: readonly [Point, Point, Point, Point],
  divisionsLong = 8,
  divisionsShort = 4,
): Point[] {
  const edgeLength = (i: number) => distance(boundary[i], boundary[(i + 1) % 4]);
  const pairA = edgeLength(0) + edgeLength(2); // opposite pair
  const pairB = edgeLength(1) + edgeLength(3);
  const longIsPairA = pairA >= pairB;

  const points: Point[] = [...boundary];
  for (let i = 0; i < 4; i++) {
    const isLongEdge = i % 2 === 0 ? longIsPairA : !longIsPairA;
    const divisions = isLongEdge ? divisionsLong : divisionsShort;
    const start = boundary[i];
    const end = boundary[(i + 1) % 4];
    for (let k = 1; k < divisions; k++) {
      points.push(lerp(start, end, k / divisions));
    }
  }
  return points;
}
