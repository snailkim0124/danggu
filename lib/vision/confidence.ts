/**
 * Recognition confidence scoring (plan Phase 1 step 6).
 *
 * Design
 * ------
 * Five independent factors, each in 0..1, combined as a **weighted geometric
 * mean**. Geometric rather than arithmetic because these are conjunctive
 * requirements, not a scorecard: a perfect table fit with a coin-flip colour
 * assignment is not "mostly right", it is wrong, and an arithmetic mean would
 * happily average it up past the threshold. With a geometric mean any factor
 * near zero drags the whole score to zero, which is the behaviour we want —
 * the cost of an unnecessary confirmation tap is trivial next to the cost of a
 * silent cue-ball swap (plan Risk "인접 테이블/색상 오분류로 큐볼 스왑").
 *
 * The factors are deliberately chosen to be *independent of the fit itself*
 * wherever possible: the aspect-ratio check uses the known real table
 * proportions, which no part of the boundary fit was allowed to see, so it can
 * catch a confidently-fitted but wrong quad.
 *
 * All functions here are pure and unit-tested; nothing imports OpenCV.
 */

import { CONFIDENCE_THRESHOLD, PLAUSIBLE_CAMERA_HEIGHT_MM } from './constants';
import { clamp } from './geometry';

export interface ConfidenceInputs {
  /**
   * Pixel-space fit-error signals feeding `scoreTableFit` — the RMS residual
   * of each of the four cushion line fits, plus each corner's estimated
   * extrapolation error (`table.ts#cornerExtrapolationErrorPx`; 0 for a
   * corner that didn't need extrapolating). `scoreTableFit` only ever looks
   * at the worst entry, so these share one array rather than being scored
   * separately — a corner can be positionally wrong even when every side's
   * own RMS looks fine (see that function's doc for why).
   */
  sideResidualsPx: readonly number[];
  /** Image diagonal in pixels — the scale the residuals are judged against. */
  imageDiagonalPx: number;
  /**
   * 0..1 agreement between the two independent focal-length constraints
   * implied by the homography (`TableFrame.rectangleConsistency`).
   */
  rectangleConsistency: number;
  /** How many balls were accepted (we need exactly 4). */
  ballsFound: number;
  /** Mean shape score of the accepted balls (0..1), from `BallCandidate.score`. */
  meanBallScore: number;
  /** Colour-assignment margin from `classifyBallColors` (0..1). */
  colorMargin: number;
  /** Recovered camera height above the cloth, in mm. */
  cameraHeightMm: number;
  /** Whether the focal length was measured from the photo or assumed. */
  focalWasMeasured: boolean;
  /** `BallDetectionResult.radiusScaleCorrection` — set only when ball
   * detection needed to rescale its size expectations to find 4 balls at
   * all. See `scorePoseSanity`'s doc. */
  radiusScaleCorrection?: number;
}

export interface ConfidenceBreakdown {
  tableFit: number;
  rectangleConsistency: number;
  ballDetection: number;
  colorSeparation: number;
  poseSanity: number;
  /** Weighted geometric mean of the five factors. */
  overall: number;
}

/**
 * Weights are exponents in the geometric mean. Colour separation carries the
 * most weight because it is the only factor whose failure is *invisible* to
 * the user: a bad table fit produces an obviously skewed diagram, but a
 * white/yellow swap produces a diagram that looks perfectly reasonable and is
 * entirely wrong.
 */
const WEIGHTS = {
  tableFit: 1.0,
  rectangleConsistency: 1.0,
  ballDetection: 1.2,
  colorSeparation: 1.6,
  poseSanity: 0.8,
} as const;

export function scoreConfidence(inputs: ConfidenceInputs): ConfidenceBreakdown {
  const tableFit = scoreTableFit(inputs.sideResidualsPx, inputs.imageDiagonalPx);
  const rectangle = clamp(inputs.rectangleConsistency, 0, 1);
  const ballDetection = scoreBallDetection(inputs.ballsFound, inputs.meanBallScore);
  const colorSeparation = scoreColorSeparation(inputs.colorMargin);
  const poseSanity = scorePoseSanity(inputs.cameraHeightMm, inputs.focalWasMeasured, inputs.radiusScaleCorrection);

  const overall = weightedGeometricMean([
    [tableFit, WEIGHTS.tableFit],
    [rectangle, WEIGHTS.rectangleConsistency],
    [ballDetection, WEIGHTS.ballDetection],
    [colorSeparation, WEIGHTS.colorSeparation],
    [poseSanity, WEIGHTS.poseSanity],
  ]);

  return {
    tableFit,
    rectangleConsistency: rectangle,
    ballDetection,
    colorSeparation,
    poseSanity,
    overall,
  };
}

export function needsManualCorrection(
  confidence: number,
  threshold: number = CONFIDENCE_THRESHOLD
): boolean {
  return confidence < threshold;
}

/**
 * Cushion lines should sit within a fraction of a percent of the image
 * diagonal. A residual of 0.15% of the diagonal (≈3px on a 2000px diagonal)
 * scores ~0.5 — by then the quad is off by roughly a ball's width in mm at
 * typical scales, which is already at the edge of the 8mm geometric gate.
 */
export function scoreTableFit(residualsPx: readonly number[], imageDiagonalPx: number): number {
  if (residualsPx.length === 0 || !(imageDiagonalPx > 0)) return 0;
  const worst = Math.max(...residualsPx);
  if (!Number.isFinite(worst)) return 0;
  const relative = worst / imageDiagonalPx;
  return clamp(Math.exp(-relative / 0.0022), 0, 1);
}

/**
 * We need exactly four balls. Finding three is not "75% right" — the missing
 * ball may be the cue ball, and every recommendation would be built on a
 * fiction — so a short count collapses the score rather than reducing it
 * proportionally.
 */
export function scoreBallDetection(ballsFound: number, meanBallScore: number): number {
  if (ballsFound < 4) return 0;
  return clamp(meanBallScore, 0, 1);
}

/**
 * Map the winning colour hypothesis's margin onto 0..1. A margin below ~0.15
 * means a competing assignment explained the photo nearly as well, which is
 * the cue-ball-swap risk; it is pushed towards zero hard.
 */
export function scoreColorSeparation(margin: number): number {
  return clamp(1 - Math.exp(-margin / 0.18), 0, 1);
}

/**
 * A recovered camera height outside the plausible band means the intrinsics or
 * the quad are wrong, which in turn means the parallax correction is wrong —
 * and a wrong parallax correction is worse than none, because it moves balls
 * confidently in an arbitrary direction. An assumed (rather than measured)
 * focal length is a soft penalty, not a failure: it degrades the correction's
 * accuracy without invalidating it.
 */
export function scorePoseSanity(
  cameraHeightMm: number,
  focalWasMeasured: boolean,
  /** `BallDetectionResult.radiusScaleCorrection` — set only when ball
   * detection's own pose-scale pass found fewer than 4 balls and had to
   * rescale by this factor to find the rest (`balls.ts#resolveRadiusEvaluations`).
   * Independent evidence the pose is unreliable beyond what camera
   * height/focal-length-measured already capture, since a wrong focal length
   * can still land in a plausible height range while still being wrong. */
  radiusScaleCorrection?: number
): number {
  if (!Number.isFinite(cameraHeightMm)) return 0;
  // A camera at or below the cloth is not "implausible", it is impossible —
  // the pose decomposition picked a mirrored solution. No smooth penalty:
  // nothing derived from that pose is usable.
  if (!(cameraHeightMm > 0)) return 0;
  const { min, max } = PLAUSIBLE_CAMERA_HEIGHT_MM;
  let height: number;
  if (cameraHeightMm >= min && cameraHeightMm <= max) {
    height = 1;
  } else {
    // Decay smoothly outside the band rather than cliff-edging to zero, in
    // log-space so "half the plausible minimum" and "twice the maximum" are
    // penalised alike.
    const target = cameraHeightMm < min ? min : max;
    const logGap = Math.abs(Math.log(Math.max(cameraHeightMm, 1) / target));
    height = clamp(Math.exp(-((logGap / 0.35) ** 2)), 0, 1);
  }
  const base = height * (focalWasMeasured ? 1 : 0.75);
  if (radiusScaleCorrection === undefined) return base;
  // Same log-space decay shape as the height band above, just centred on "no
  // correction needed" (factor of 1) instead of a plausible range — a 2x
  // rescue costs a moderate amount, a 5x+ one collapses this factor almost
  // entirely, same as an implausible camera height would.
  const scaleLogGap = Math.abs(Math.log(Math.max(radiusScaleCorrection, 1e-6)));
  const scalePenalty = clamp(Math.exp(-((scaleLogGap / 0.5) ** 2)), 0, 1);
  return base * scalePenalty;
}

function weightedGeometricMean(pairs: ReadonlyArray<readonly [number, number]>): number {
  let logSum = 0;
  let weightSum = 0;
  for (const [value, weight] of pairs) {
    if (!(value > 0)) return 0;
    logSum += weight * Math.log(clamp(value, 0, 1));
    weightSum += weight;
  }
  if (weightSum === 0) return 0;
  return clamp(Math.exp(logSum / weightSum), 0, 1);
}
