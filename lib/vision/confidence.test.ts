import { describe, expect, it } from 'vitest';
import {
  needsManualCorrection,
  scoreBallDetection,
  scoreColorSeparation,
  scoreConfidence,
  scorePoseSanity,
  scoreTableFit,
  type ConfidenceInputs,
} from './confidence';
import { CONFIDENCE_THRESHOLD } from './constants';

/**
 * Plan verification step: "인식 신뢰도 임계값 미만 시 확인/보정 화면이 실제로
 * 트리거되는지 확인" — i.e. a doubtful recognition must actually route the user
 * to the manual-correction screen, not slip through.
 */

/** A recognition where everything went right. */
const CLEAN: ConfidenceInputs = {
  sideResidualsPx: [0.9, 1.0, 1.1, 1.2],
  imageDiagonalPx: 1600,
  rectangleConsistency: 0.99,
  ballsFound: 4,
  meanBallScore: 0.85,
  colorMargin: 0.7,
  cameraHeightMm: 1400,
  focalWasMeasured: true,
};

describe('scoreConfidence', () => {
  it('scores a clean recognition above the manual-correction threshold', () => {
    const b = scoreConfidence(CLEAN);
    expect(b.overall).toBeGreaterThan(CONFIDENCE_THRESHOLD);
    expect(needsManualCorrection(b.overall)).toBe(false);
  });

  it('collapses when the colour assignment is ambiguous, even if everything else is perfect', () => {
    // This is the whole point of the geometric mean: a cue-ball swap is not
    // something a great table fit can compensate for.
    const b = scoreConfidence({ ...CLEAN, colorMargin: 0.01 });
    expect(b.colorSeparation).toBeLessThan(0.1);
    expect(b.overall).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(needsManualCorrection(b.overall)).toBe(true);
  });

  it('collapses when a ball is missing', () => {
    const b = scoreConfidence({ ...CLEAN, ballsFound: 3 });
    expect(b.overall).toBe(0);
    expect(needsManualCorrection(b.overall)).toBe(true);
  });

  it('collapses when the quad is not consistent with a rectangle', () => {
    const b = scoreConfidence({ ...CLEAN, rectangleConsistency: 0.02 });
    expect(b.overall).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('collapses when the recovered camera is in a physically impossible place', () => {
    const b = scoreConfidence({ ...CLEAN, cameraHeightMm: -800 });
    expect(b.poseSanity).toBe(0);
    expect(b.overall).toBe(0);
  });

  it('compounds weak factors rather than averaging them away', () => {
    const weak = scoreConfidence({ ...CLEAN, colorMargin: 0.02, meanBallScore: 0.2 });
    const strongOnly = scoreConfidence({ ...CLEAN, colorMargin: 0.02 });
    // Degrading a second factor must lower the score further, not average out.
    expect(weak.overall).toBeLessThan(strongOnly.overall);
  });

  it('stays within 0..1 for every factor', () => {
    const b = scoreConfidence(CLEAN);
    for (const [key, value] of Object.entries(b)) {
      expect(value, key).toBeGreaterThanOrEqual(0);
      expect(value, key).toBeLessThanOrEqual(1);
    }
  });
});

describe('scoreTableFit', () => {
  it('rewards tight line fits and punishes loose ones', () => {
    const tight = scoreTableFit([0.5, 0.6, 0.5, 0.7], 2000);
    const loose = scoreTableFit([0.5, 0.6, 0.5, 12], 2000);
    expect(tight).toBeGreaterThan(0.8);
    expect(loose).toBeLessThan(0.1);
  });

  it('is judged relative to image size, not in absolute pixels', () => {
    // The same *relative* error must score the same at any resolution.
    expect(scoreTableFit([2], 2000)).toBeCloseTo(scoreTableFit([4], 4000), 6);
  });

  it('returns 0 for a non-finite residual (a side that could not be fitted)', () => {
    expect(scoreTableFit([1, 1, 1, Infinity], 2000)).toBe(0);
    expect(scoreTableFit([], 2000)).toBe(0);
  });
});

describe('scoreBallDetection', () => {
  it('is zero unless exactly four balls were found', () => {
    expect(scoreBallDetection(3, 0.99)).toBe(0);
    expect(scoreBallDetection(0, 1)).toBe(0);
    expect(scoreBallDetection(4, 0.9)).toBeCloseTo(0.9, 6);
  });
});

describe('scoreColorSeparation', () => {
  it('rises monotonically with the decision margin', () => {
    const points = [0, 0.05, 0.15, 0.4, 0.9].map(scoreColorSeparation);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeGreaterThan(points[i - 1]);
    }
    expect(points[0]).toBe(0);
  });
});

describe('scorePoseSanity', () => {
  it('accepts plausible camera heights and rejects implausible ones', () => {
    expect(scorePoseSanity(1400, true)).toBe(1);
    expect(scorePoseSanity(250, true)).toBe(1);
    expect(scorePoseSanity(20_000, true)).toBeLessThan(0.1);
    expect(scorePoseSanity(-500, true)).toBe(0);
  });

  it('applies a soft penalty when the focal length was assumed rather than measured', () => {
    expect(scorePoseSanity(1400, false)).toBeLessThan(scorePoseSanity(1400, true));
    expect(scorePoseSanity(1400, false)).toBeGreaterThan(0.5);
  });
});

describe('needsManualCorrection', () => {
  it('triggers strictly below the threshold', () => {
    expect(needsManualCorrection(CONFIDENCE_THRESHOLD)).toBe(false);
    expect(needsManualCorrection(CONFIDENCE_THRESHOLD - 1e-9)).toBe(true);
  });

  it('honours a caller-supplied threshold', () => {
    expect(needsManualCorrection(0.8, 0.9)).toBe(true);
    expect(needsManualCorrection(0.8, 0.7)).toBe(false);
  });
});
