/**
 * Tuning constants for the Path Calculation engine.
 *
 * Everything the physics/geometry approximations depend on lives here so the
 * fidelity level of the engine is inspectable in one place, and so Phase 5
 * ("고급기술샷 스핀 시뮬레이션 정밀도는 Phase 5 실측 이후 튜닝") can retune
 * without touching the algorithm.
 *
 * Plan: `.omc/plans/danggu-4gu-path-guide-plan.md` Phase 2.
 */

import type { ShotTechnique } from '@/lib/types';

/** Korean 4구(사구) carom ball: 65.5mm diameter (international carom is 61.5mm). */
export const BALL_DIAMETER_MM = 65.5;
export const BALL_RADIUS_MM = BALL_DIAMETER_MM / 2;

/** Cue-ball tip offset. Same shape as `Shot.tipOffset`, -1..1 on each axis. */
export interface TipOffset {
  /** Vertical tip offset, as a fraction of the maximum safe strike height
   * (±R/2). `0` = centre ball — which imparts no spin at all, so the cue ball
   * slides (stun-like) at short range and rolls naturally at long range;
   * `-1` = max draw(끌어치기), `+1` = max follow(밀어치기). */
  vertical: number;
  /** Side/english offset. Positive = right-hand english about +z; only
   * observable in this model through cushion rebound. */
  horizontal: number;
}

/**
 * How opponent-ball contact is treated by the hard rule filter.
 *
 * - `'strict'`: ANY contact with the opponent ball anywhere in the stroke is a
 *   foul, even after both reds are already contacted.
 * - `'before-score'` (default): contact before the score is always a foul;
 *   contact after the score is a foul only if it happens within
 *   `postScoreRolloutTableLengths` of rollout, because past that the player can
 *   simply stroke softer and stop the cue ball short. Every candidate here is
 *   simulated at the maximum plausible stroke, so `'strict'` would reject
 *   legitimate shots for a rollout the player would never actually play.
 */
export type OpponentContactPolicy = 'strict' | 'before-score';

export interface PathCalcConfig {
  // --- geometry -----------------------------------------------------------
  ballRadiusMm: number;
  /** Aim-angle resolution of the 360° sweep. Also the smallest angular
   * tolerance window the engine can detect at all — a solution narrower than
   * this may be skipped, which is acceptable since such a shot would be
   * suppressed as zero-confidence anyway. */
  coarseStepDeg: number;
  /** Bisection steps used to refine each success window's edges. */
  bisectIterations: number;
  /** Hard cap on collision events per simulated stroke. */
  maxEvents: number;

  // --- energy / stroke budget ---------------------------------------------
  /** Roll distance of the strongest plausible stroke, in table long-sides. */
  maxTravelTableLengths: number;
  /** Speed retained through a cushion rebound (energy ≈ this squared). */
  cushionSpeedRetention: number;
  /** Effort thresholds (in table long-sides) separating `ForceLevel` 1|2|3|4|5. */
  forceLevelThresholdsTableLengths: [number, number, number, number];

  // --- ball-ball collision model ------------------------------------------
  /** Coefficient on the tangent-line (90° rule) component after contact. 5/7
   * reproduces the standard 30° rule for a rolling cue ball. */
  tangentGain: number;
  /** Post-contact velocity along the original line for a naturally rolling cue
   * ball, as a fraction of the incoming speed. 2/7 is the textbook value. */
  naturalRollSpin: number;
  /**
   * Post-contact velocity along the original line per unit of `tipOffset.vertical`,
   * for a cue ball that has not yet started rolling. Striking at height `h`
   * gives a spin ratio σ = 5h/2R, so the tip-offset limit of h = ±R/2 gives
   * σ = ±1.25; the spin contributes 2/7·σ to the post-contact velocity, hence
   * 2/7 · 1.25 = 5/14.
   */
  spinToVelocity: number;
  /**
   * Distance over which a sliding cue ball converges to natural roll (1/e per
   * `slidingLengthMm`). This is what makes a centre-ball hit behave like a
   * stun shot up close and like a rolling shot at range — and why draw dies
   * out over distance, exactly as it does on a real table.
   */
  slidingLengthMm: number;
  /** Below this post-contact speed the cue ball is treated as stopping dead. */
  minSpeed: number;

  // --- side spin ----------------------------------------------------------
  /** Tangential velocity added at a cushion per unit of side spin. */
  cushionSpinGain: number;
  /** Side spin surviving each cushion. */
  sideSpinDecayPerCushion: number;

  // --- rule model ---------------------------------------------------------
  opponentContactPolicy: OpponentContactPolicy;
  /** Rollout window (in table long-sides) after the score inside which an
   * opponent-ball contact still counts as a foul under `'before-score'`. */
  postScoreRolloutTableLengths: number;

  // --- scoring / confidence ------------------------------------------------
  /** Angular tolerance (deg) at which `difficultyScore` saturates at 1. */
  easyToleranceDeg: number;
  /**
   * Expected 1σ ball-position recognition error (mm). The plan's geometric
   * gate sets ≤8mm RMS as the *pass ceiling*, so the typical error a passing
   * pipeline actually delivers is taken as half that. Raise it to 8 to see how
   * recommendations degrade at the worst still-acceptable recognition quality.
   */
  recognitionErrorMm: number;
  /** Clamp range for the recognition-derived confidence floor (deg). */
  confidenceFloorMinDeg: number;
  confidenceFloorMaxDeg: number;
  /** Tolerance (deg) at which shot confidence reaches 1. */
  confidenceFullDeg: number;
  /** Per-technique fidelity multiplier on confidence — an honest discount for
   * how much of the model is approximation rather than geometry. */
  techniqueFidelity: Record<ShotTechnique, number>;

  // --- kiss risk (의도치 않은 공-공 2차 충돌) --------------------------------
  /**
   * Grey-zone width (mm) beyond exact contact distance (`2 × ballRadiusMm`)
   * used to taper the kiss-risk confidence penalty to zero — see
   * `lib/pathcalc/simulate.ts`'s module doc for the full model. Tuned
   * qualitatively, not measured, same as `THIN_CUT_MAX_THICKNESS` and friends
   * in `candidates.ts` — deliberately NOT reusing `recognitionErrorMm` (a much
   * narrower camera-error figure with a different meaning) as this margin.
   */
  kissMarginMm: number;
  /** Confidence multiplier applied when a struck ball's projected path passes
   * dead-on through another ball's centre (distance ≤ `2 × ballRadiusMm`) —
   * deliberately not 0, since this is a soft down-rank, not a hard filter. */
  kissMinMultiplier: number;

  // --- selection ------------------------------------------------------------
  /** Candidates whose aim angles are closer than this are the same shot. */
  duplicateAngleDeg: number;
  topN: number;
  spinSettings: TipOffset[];

  // --- near-miss fallback ---------------------------------------------------
  /** Miss-distance equivalent charged for a foul, so any legal near-miss beats
   * any foul when picking the fallback shot. */
  foulPenaltyMm: number;
  /** Miss distance (mm) at which fallback confidence decays to 0. */
  nearMissScaleMm: number;
  /** Ceiling on the confidence a `ruleValid: false` fallback may report. */
  nearMissConfidenceCap: number;

  // --- numerical ------------------------------------------------------------
  minSegmentMm: number;
  /** Separation past 2R at which a just-contacted ball becomes hittable again. */
  contactSlackMm: number;
}

/**
 * Spin settings swept for candidate generation.
 *
 * `{0, 0}` is the baseline (natural/center-ball roll); every other entry
 * strikes with some draw/follow/회전. Spin doesn't change `technique` — a
 * cushion-count classification is applied to every entry's result the same
 * way (see `classifyTechnique`) — it only changes the resulting `tipOffset`
 * and, via `classifySkillCategory`, which survey rating personalizes it.
 * Kept deliberately small — each entry costs a full 360° sweep.
 */
export const DEFAULT_SPIN_SETTINGS: TipOffset[] = [
  { vertical: 0, horizontal: 0 }, // 중심 — direct/bank 기준 스트로크
  { vertical: -1, horizontal: 0 }, // 강한 끌어치기
  { vertical: -0.6, horizontal: 0 }, // 끌어치기
  { vertical: 1, horizontal: 0 }, // 밀어치기
  { vertical: 0.6, horizontal: 0 }, // 약한 밀어치기
  { vertical: 0, horizontal: 0.8 }, // 오른 회전
  { vertical: 0, horizontal: -0.8 }, // 왼 회전
  { vertical: -0.8, horizontal: 0.7 }, // 끌어치기 + 오른 회전
  { vertical: -0.8, horizontal: -0.7 }, // 끌어치기 + 왼 회전
  { vertical: 0.8, horizontal: 0.7 }, // 밀어치기 + 오른 회전
  { vertical: 0.8, horizontal: -0.7 }, // 밀어치기 + 왼 회전
];

export const DEFAULT_PATHCALC_CONFIG: PathCalcConfig = {
  ballRadiusMm: BALL_RADIUS_MM,
  coarseStepDeg: 0.5,
  bisectIterations: 14,
  maxEvents: 14,

  maxTravelTableLengths: 3.5,
  cushionSpeedRetention: 0.78,
  forceLevelThresholdsTableLengths: [0.55, 1.1, 1.9, 2.8],

  tangentGain: 5 / 7,
  naturalRollSpin: 2 / 7,
  spinToVelocity: 5 / 14,
  slidingLengthMm: 1000,
  minSpeed: 0.02,

  cushionSpinGain: 0.28,
  sideSpinDecayPerCushion: 0.6,

  opponentContactPolicy: 'before-score',
  postScoreRolloutTableLengths: 0.5,

  easyToleranceDeg: 10,
  recognitionErrorMm: 4,
  confidenceFloorMinDeg: 1,
  confidenceFloorMaxDeg: 3,
  confidenceFullDeg: 6,
  techniqueFidelity: {
    direct: 1,
    bank1: 0.95,
    bank2plus: 0.85,
    // Aiming at a cushion with no ball to reference (뱅크샷/빈쿠션치기) is the
    // hardest technique tier there is now that spin no longer has one of its
    // own (see `ShotTechnique`'s doc) — lowest fidelity of the four.
    bankShot: 0.75,
  },

  kissMarginMm: 20,
  kissMinMultiplier: 0.1,

  duplicateAngleDeg: 4,
  topN: 3,
  spinSettings: DEFAULT_SPIN_SETTINGS,

  foulPenaltyMm: 100000,
  nearMissScaleMm: 200,
  nearMissConfidenceCap: 0.3,

  minSegmentMm: 0.01,
  contactSlackMm: 0.05,
};

export function resolveConfig(overrides?: Partial<PathCalcConfig>): PathCalcConfig {
  return overrides ? { ...DEFAULT_PATHCALC_CONFIG, ...overrides } : DEFAULT_PATHCALC_CONFIG;
}
