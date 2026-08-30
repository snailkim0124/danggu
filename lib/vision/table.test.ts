import { describe, expect, it } from 'vitest';
import { computeVisibleFractions, cornerExtrapolationErrorPx, type SideFit } from './table';
import type { Line2, Vec2 } from './geometry';

/**
 * `cornerExtrapolationErrorPx` — found necessary from real photos (2026-08-30,
 * `docs/testing/geometric-gate-guide.md` results): a line-intersection corner
 * can land far outside the real table even when both contributing sides
 * individually have unremarkable RMS/span numbers. See the function's doc for
 * the full story; these tests pin the two directions that story depends on:
 * a precise line stays trusted at any extrapolation distance (the whole point
 * of this module — see `pipeline.test.ts` "still recovers the table when a
 * corner is cropped out of frame"), while a noisy one is penalised more the
 * further it's extrapolated.
 */

// A line along y=0, so (dx,dy) = (-line.b, line.a) = (-1, 0) — the along-line
// coordinate is simply -x, making the arithmetic easy to reason about by hand.
const HORIZONTAL_LINE: Line2 = { a: 0, b: 1, c: 0 };

function side(overrides: Partial<SideFit> = {}): SideFit {
  return {
    line: HORIZONTAL_LINE,
    rmsResidual: 1,
    pointCount: 100,
    spanPx: 100,
    rangeLo: -100,
    rangeHi: 0,
    ...overrides,
  };
}

describe('cornerExtrapolationErrorPx', () => {
  it('is 0 when the corner falls within the side\'s observed range (interpolation, not extrapolation)', () => {
    const s = side();
    expect(cornerExtrapolationErrorPx({ x: 50, y: 0 }, s)).toBe(0); // t = -50, inside [-100, 0]
    expect(cornerExtrapolationErrorPx({ x: 0, y: 0 }, s)).toBe(0); // exactly at rangeHi
    expect(cornerExtrapolationErrorPx({ x: 100, y: 0 }, s)).toBe(0); // exactly at rangeLo
  });

  it('stays ~0 for a precise (near-zero RMS) line no matter how far it is extrapolated', () => {
    // This is the case a first, distance-only version of this check broke:
    // a clean synthetic render's fitted line has ~0 RMS, and a corner cropped
    // out of frame must still cost nothing (module docstring, `pipeline.test.ts`).
    const precise = side({ rmsResidual: 0 });
    expect(cornerExtrapolationErrorPx({ x: -1000, y: 0 }, precise)).toBe(0);
    expect(cornerExtrapolationErrorPx({ x: 100000, y: 0 }, precise)).toBe(0);
  });

  it('grows with extrapolation distance for a noisy line, and is 0 for the same distance on a precise one', () => {
    const noisy = side({ rmsResidual: 10, spanPx: 100 });
    const precise = side({ rmsResidual: 0.01, spanPx: 100 });
    // x = 200 -> t = -200, which is 200px beyond rangeLo (-100).
    const noisyError = cornerExtrapolationErrorPx({ x: 200, y: 0 }, noisy);
    const preciseError = cornerExtrapolationErrorPx({ x: 200, y: 0 }, precise);
    expect(noisyError).toBeGreaterThan(0);
    expect(noisyError).toBeGreaterThan(preciseError * 100);
  });

  it('scales linearly with extrapolation distance for a fixed rms/span ratio', () => {
    const s = side({ rmsResidual: 5, spanPx: 100 }); // ratio = 0.05 px error per px extrapolated
    // t(x=150) = -150, 50px beyond rangeLo(-100); t(x=200) = -200, 100px beyond.
    const at50 = cornerExtrapolationErrorPx({ x: 150, y: 0 }, s);
    const at100 = cornerExtrapolationErrorPx({ x: 200, y: 0 }, s);
    expect(at50).toBeCloseTo(50 * (5 / 100), 6);
    expect(at100).toBeCloseTo(100 * (5 / 100), 6);
    expect(at100).toBeCloseTo(at50 * 2, 6);
  });

  it('treats extrapolation beyond either end of the range symmetrically', () => {
    const s = side({ rmsResidual: 5, spanPx: 100, rangeLo: -100, rangeHi: 0 });
    // x = -50 -> t = 50, which is 50px beyond rangeHi (0).
    const beyondHi = cornerExtrapolationErrorPx({ x: -50, y: 0 }, s);
    // x = 150 -> t = -150, which is 50px beyond rangeLo (-100).
    const beyondLo = cornerExtrapolationErrorPx({ x: 150, y: 0 }, s);
    expect(beyondHi).toBeCloseTo(beyondLo, 6);
  });
});

/**
 * `computeVisibleFractions` — proposed (2026-08-31) as part of a graceful-
 * degradation policy for partially-visible cushions: a side fitted precisely
 * but from only a small fraction of its own true (reconstructed) length is a
 * materially weaker basis for the corner it contributes to than the same RMS
 * from a well-covered side, which `sides[].rmsResidual` alone can't tell
 * apart — see `MIN_VISIBLE_FRACTION`'s doc for how the 0.5 cutoff was chosen.
 */
describe('computeVisibleFractions', () => {
  // A 100x100 synthetic square. sides[i] is the fit for corners[i] -> corners[(i+1)%4].
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  function sidesWithSpans(spans: [number, number, number, number]): [SideFit, SideFit, SideFit, SideFit] {
    return spans.map((spanPx) => side({ spanPx })) as [SideFit, SideFit, SideFit, SideFit];
  }

  it("divides each side's span by its own reconstructed full length, in boundary order", () => {
    const sides = sidesWithSpans([80, 100, 30, 50]);
    const fractions = computeVisibleFractions(corners, sides, corners); // boundary === corners here
    expect(fractions).toEqual([0.8, 1.0, 0.3, 0.5]);
  });

  it('clamps a span that (numerically) exceeds the reconstructed length to 1', () => {
    const sides = sidesWithSpans([120, 100, 100, 100]);
    const fractions = computeVisibleFractions(corners, sides, corners);
    expect(fractions[0]).toBe(1);
  });

  it('matches edges by their corner points, not by array index — survives reordering/reversal', () => {
    const sides = sidesWithSpans([80, 100, 30, 50]);
    // Same 4 points as `corners`, but in a scrambled order — exactly what
    // `orderQuadClockwise` can hand back (a rotation and/or a winding flip).
    const boundary: [Vec2, Vec2, Vec2, Vec2] = [corners[2], corners[1], corners[0], corners[3]];
    const fractions = computeVisibleFractions(corners, sides, boundary);
    // boundary edge 0 (corners[2]->corners[1]) is the reverse of sides[1]'s
    // own edge (corners[1]->corners[2]) -> spans[1]=100. Edge 1
    // (corners[1]->corners[0]) reverses sides[0] -> spans[0]=80. Edge 2
    // (corners[0]->corners[3]) reverses sides[3] -> spans[3]=50. Edge 3
    // (corners[3]->corners[2]) reverses sides[2] -> spans[2]=30. All four
    // reconstructed edges are still length 100 regardless of order.
    expect(fractions).toEqual([1.0, 0.8, 0.5, 0.3]);
  });
});
