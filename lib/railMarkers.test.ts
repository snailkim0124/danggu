import { describe, expect, it } from 'vitest';
import type { Point } from '@/lib/types';
import { railMarkerPoints } from './railMarkers';

// A 2000x1000 rectangle, boundary order [TL, TR, BR, BL] per TableGeometry's convention.
const RECT: [Point, Point, Point, Point] = [
  { x: 0, y: 0 },
  { x: 2000, y: 0 },
  { x: 2000, y: 1000 },
  { x: 0, y: 1000 },
];

describe('railMarkerPoints', () => {
  it('includes all four corners', () => {
    const points = railMarkerPoints(RECT);
    for (const corner of RECT) {
      expect(points.some((p) => p.x === corner.x && p.y === corner.y)).toBe(true);
    }
  });

  it('returns the default 8/4-division count: 4 corners + 7*2 long interior + 3*2 short interior', () => {
    const points = railMarkerPoints(RECT);
    expect(points).toHaveLength(4 + 7 * 2 + 3 * 2);
  });

  it('places long-rail interior points evenly along the long (top/bottom) edges', () => {
    const points = railMarkerPoints(RECT, 4, 2); // small divisions, easy to check by hand
    // Top edge (0,0)->(2000,0) divided into 4: interior points at x=500,1000,1500, y=0.
    for (const x of [500, 1000, 1500]) {
      expect(points.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - 0) < 1e-6)).toBe(true);
    }
    // Bottom edge (2000,1000)->(0,1000) divided into 4: interior points at x=1500,1000,500, y=1000.
    for (const x of [500, 1000, 1500]) {
      expect(points.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - 1000) < 1e-6)).toBe(true);
    }
  });

  it('places short-rail interior points evenly along the short (left/right) edges', () => {
    const points = railMarkerPoints(RECT, 4, 2); // short divisions=2 -> one interior point per short edge
    // Right edge (2000,0)->(2000,1000) divided into 2: interior point at (2000,500).
    expect(points.some((p) => Math.abs(p.x - 2000) < 1e-6 && Math.abs(p.y - 500) < 1e-6)).toBe(true);
    // Left edge (0,1000)->(0,0) divided into 2: interior point at (0,500).
    expect(points.some((p) => Math.abs(p.x - 0) < 1e-6 && Math.abs(p.y - 500) < 1e-6)).toBe(true);
  });

  it('classifies long/short by opposite-edge pair sums, not by absolute edge index', () => {
    // A boundary whose winding starts on a SHORT edge first (edges 0/2 are the
    // short pair, 1/3 are the long pair) -- rotate RECT's corner order by one.
    const rotated: [Point, Point, Point, Point] = [RECT[1], RECT[2], RECT[3], RECT[0]];
    const points = railMarkerPoints(rotated, 4, 2);
    // Edge 1 of `rotated` is (2000,1000)->(0,1000) — the long bottom edge —
    // and should get 3 interior points (divisions=4), not 1 (divisions=2).
    const bottomInterior = points.filter(
      (p) => Math.abs(p.y - 1000) < 1e-6 && p.x !== 2000 && p.x !== 0,
    );
    expect(bottomInterior).toHaveLength(3);
  });

  it('handles a slightly non-rectangular boundary without throwing, still classifying by pair sum', () => {
    const wonky: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 2005, y: 5 }, // top edge very slightly longer/tilted
      { x: 2000, y: 1000 },
      { x: -5, y: 995 },
    ];
    expect(() => railMarkerPoints(wonky)).not.toThrow();
    expect(railMarkerPoints(wonky).length).toBeGreaterThan(4);
  });
});
