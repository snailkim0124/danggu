import { describe, expect, it } from 'vitest';
import {
  distanceToLine,
  fitCircleRobust,
  fitLineTls,
  lineIntersection,
  lineThroughPoints,
  mat3Inverse,
  mat3Multiply,
  applyHomography,
  orderQuadClockwise,
  pointInPolygon,
  signedPolygonArea,
  solveLinearSystem,
  MAT3_IDENTITY,
} from './geometry';

describe('fitLineTls', () => {
  it('fits a perfectly vertical line, where ordinary least squares diverges', () => {
    // The reason TLS is used at all: a cushion running straight down the image
    // has infinite slope, and a y-on-x regression cannot represent it.
    const points = Array.from({ length: 40 }, (_, i) => ({ x: 100, y: i * 5 }));
    const { line, rmsResidual } = fitLineTls(points);
    expect(rmsResidual).toBeCloseTo(0, 9);
    expect(distanceToLine(line, { x: 100, y: 999 })).toBeCloseTo(0, 9);
    expect(distanceToLine(line, { x: 107, y: 12 })).toBeCloseTo(7, 9);
  });

  it('recovers a known oblique line', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 3 * i + 10 }));
    const { line, rmsResidual } = fitLineTls(points);
    expect(rmsResidual).toBeCloseTo(0, 9);
    for (const t of [-20, 0, 33, 200]) {
      expect(distanceToLine(line, { x: t, y: 3 * t + 10 })).toBeCloseTo(0, 8);
    }
  });

  it('reports a residual that reflects the scatter', () => {
    const clean = fitLineTls(Array.from({ length: 30 }, (_, i) => ({ x: i, y: 5 })));
    const noisy = fitLineTls(
      Array.from({ length: 30 }, (_, i) => ({ x: i, y: 5 + (i % 2 ? 2 : -2) }))
    );
    expect(clean.rmsResidual).toBeCloseTo(0, 9);
    // Not exactly 2: the alternating pattern correlates weakly with x, so the
    // fitted line tilts a hair and the perpendicular residual drops slightly.
    expect(noisy.rmsResidual).toBeCloseTo(2, 2);
  });

  it('is orientation-independent: rotating the input rotates the fit, not its quality', () => {
    const base = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 0.4 * i + 3 }));
    const theta = 1.1;
    const rotated = base.map((p) => ({
      x: p.x * Math.cos(theta) - p.y * Math.sin(theta),
      y: p.x * Math.sin(theta) + p.y * Math.cos(theta),
    }));
    expect(fitLineTls(rotated).rmsResidual).toBeCloseTo(fitLineTls(base).rmsResidual, 9);
  });

  it('rejects fewer than two points', () => {
    expect(() => fitLineTls([{ x: 0, y: 0 }])).toThrow(/at least 2 points/);
  });
});

describe('lineIntersection', () => {
  it('finds a corner that lies far outside the image — the out-of-frame case', () => {
    // Two cushion lines whose meeting point is well off-screen. Recovering it
    // is exactly why the table boundary is built from lines, not corners.
    const a = lineThroughPoints({ x: 0, y: 0 }, { x: 100, y: 10 });
    const b = lineThroughPoints({ x: 0, y: 400 }, { x: 100, y: 380 });
    const p = lineIntersection(a, b)!;
    expect(p).not.toBeNull();
    expect(p.x).toBeGreaterThan(1000);
    expect(distanceToLine(a, p)).toBeCloseTo(0, 6);
    expect(distanceToLine(b, p)).toBeCloseTo(0, 6);
  });

  it('returns null for parallel lines', () => {
    const a = lineThroughPoints({ x: 0, y: 0 }, { x: 10, y: 0 });
    const b = lineThroughPoints({ x: 0, y: 5 }, { x: 10, y: 5 });
    expect(lineIntersection(a, b)).toBeNull();
  });

  it('returns null for a grazing intersection whose position is meaningless', () => {
    const a = lineThroughPoints({ x: 0, y: 0 }, { x: 1000, y: 0 });
    const b = lineThroughPoints({ x: 0, y: 0 }, { x: 1000, y: 1 });
    expect(lineIntersection(a, b)).toBeNull();
  });
});

describe('mat3 helpers', () => {
  it('inverts a matrix back to the identity', () => {
    const m = [2, 0.3, 5, -0.1, 1.4, 8, 0.0002, -0.0004, 1];
    const product = mat3Multiply(m, mat3Inverse(m));
    for (let i = 0; i < 9; i++) {
      expect(product[i]).toBeCloseTo(MAT3_IDENTITY[i], 9);
    }
  });

  it('round-trips a point through a homography and its inverse', () => {
    const h = [1.4, 0.2, 30, -0.1, 1.1, -12, 0.0003, 0.0001, 1];
    const p = { x: 321, y: 654 };
    const back = applyHomography(mat3Inverse(h), applyHomography(h, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('refuses to invert a singular matrix', () => {
    expect(() => mat3Inverse([1, 2, 3, 2, 4, 6, 7, 8, 9])).toThrow(/singular/);
  });
});

describe('orderQuadClockwise', () => {
  it('orders scrambled corners clockwise in image space starting nearest the origin', () => {
    const corners = [
      { x: 300, y: 20 },
      { x: 10, y: 200 },
      { x: 320, y: 210 },
      { x: 20, y: 15 },
    ];
    const ordered = orderQuadClockwise(corners);
    expect(ordered[0]).toEqual({ x: 20, y: 15 });
    expect(ordered[1]).toEqual({ x: 300, y: 20 });
    expect(ordered[2]).toEqual({ x: 320, y: 210 });
    expect(ordered[3]).toEqual({ x: 10, y: 200 });
    expect(signedPolygonArea(ordered)).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const corners = [
      { x: 300, y: 20 },
      { x: 10, y: 200 },
      { x: 320, y: 210 },
      { x: 20, y: 15 },
    ];
    expect(orderQuadClockwise(orderQuadClockwise(corners))).toEqual(
      orderQuadClockwise(corners)
    );
  });

  it('rejects anything other than four points', () => {
    expect(() => orderQuadClockwise([{ x: 0, y: 0 }])).toThrow(/exactly 4/);
  });
});

describe('fitCircleRobust', () => {
  function circlePoints(cx: number, cy: number, r: number, n: number, fromAngle = 0, span = 2 * Math.PI) {
    return Array.from({ length: n }, (_, i) => {
      const t = fromAngle + (span * i) / n;
      return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
    });
  }

  it('recovers a clean circle exactly', () => {
    const fit = fitCircleRobust(circlePoints(120, 80, 25, 60));
    expect(fit.center.x).toBeCloseTo(120, 6);
    expect(fit.center.y).toBeCloseTo(80, 6);
    expect(fit.radius).toBeCloseTo(25, 6);
    expect(fit.rmsResidual).toBeCloseTo(0, 6);
  });

  it('rejects a shadow lobe that a plain centroid would follow', () => {
    // A ball blob plus the cast shadow bulging off one side — the real
    // contamination this fit exists to survive.
    const ball = circlePoints(200, 150, 30, 80);
    const shadowLobe = Array.from({ length: 22 }, (_, i) => ({
      x: 214 + (i % 6) * 3,
      y: 176 + Math.floor(i / 6) * 3,
    }));
    const contaminated = [...ball, ...shadowLobe];

    const centroidX = contaminated.reduce((a, p) => a + p.x, 0) / contaminated.length;
    const centroidY = contaminated.reduce((a, p) => a + p.y, 0) / contaminated.length;
    const centroidError = Math.hypot(centroidX - 200, centroidY - 150);

    const fit = fitCircleRobust(contaminated);
    const fitError = Math.hypot(fit.center.x - 200, fit.center.y - 150);

    expect(fitError).toBeLessThan(centroidError);
    expect(fitError).toBeLessThan(2.5);
  });

  it('fits a partial arc, as produced by a partly-occluded ball', () => {
    const fit = fitCircleRobust(circlePoints(60, 60, 18, 40, 0, Math.PI * 1.2));
    expect(fit.center.x).toBeCloseTo(60, 4);
    expect(fit.center.y).toBeCloseTo(60, 4);
    expect(fit.radius).toBeCloseTo(18, 4);
  });

  it('rejects collinear points instead of returning a nonsense circle', () => {
    const collinear = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 2 * i }));
    expect(() => fitCircleRobust(collinear)).toThrow(/degenerate|collinear/);
  });

  it('rejects fewer than three points', () => {
    expect(() => fitCircleRobust([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(/at least 3/);
  });
});

describe('pointInPolygon', () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 100, y: 10 },
    { x: 90, y: 80 },
    { x: 5, y: 70 },
  ];

  it('distinguishes inside from outside', () => {
    expect(pointInPolygon(quad, { x: 50, y: 40 })).toBe(true);
    expect(pointInPolygon(quad, { x: -5, y: 40 })).toBe(false);
    expect(pointInPolygon(quad, { x: 200, y: 40 })).toBe(false);
    expect(pointInPolygon(quad, { x: 50, y: -10 })).toBe(false);
  });
});

describe('solveLinearSystem', () => {
  it('solves a small system', () => {
    // 2x + y = 5 ; x - 3y = -6  =>  x = 9/7... verify by substitution instead.
    const x = solveLinearSystem([2, 1, 1, -3], [5, -6], 2);
    expect(2 * x[0] + x[1]).toBeCloseTo(5, 9);
    expect(x[0] - 3 * x[1]).toBeCloseTo(-6, 9);
  });

  it('handles a system needing a row swap (zero leading pivot)', () => {
    const x = solveLinearSystem([0, 2, 3, 4], [4, 10], 2);
    expect(2 * x[1]).toBeCloseTo(4, 9);
    expect(3 * x[0] + 4 * x[1]).toBeCloseTo(10, 9);
  });

  it('throws on a singular system', () => {
    expect(() => solveLinearSystem([1, 2, 2, 4], [1, 2], 2)).toThrow(/singular/);
  });
});
