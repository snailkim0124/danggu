/**
 * Path Calculation engine — public entry point.
 *
 * Consumes a `RecognitionResult` (mm-space table + balls) and produces ranked
 * `Shot` candidates per plan Phase 2. Pure TypeScript, no native dependencies,
 * safe to run inside a Vercel serverless function.
 *
 * ## The 4구(사구) rule model implemented here
 *
 * A stroke **scores** when the cue ball (whichever of white/yellow the user set
 * as `Settings.cueBallColor`) contacts **both** red object balls in one stroke,
 * in either order, directly or via any number of cushions. There is no minimum
 * cushion requirement in 4구.
 *
 * A stroke **fouls**, and is therefore hard-filtered out (`ruleValid: false`,
 * excluded from results — never merely down-ranked), when the cue ball touches
 * the **opponent ball** (the other of white/yellow):
 *
 *   - contact at any point *before* both reds are contacted → always a foul
 *   - contact *after* the score → a foul only while the cue ball is still
 *     rolling out (`postScoreRolloutTableLengths`, default half a table
 *     length). Beyond that the player can simply stroke softer and stop the cue
 *     ball short, so treating it as a foul would reject legitimate shots;
 *     it is flagged as `lateOpponentContact` and discounts confidence instead.
 *     Set `opponentContactPolicy: 'strict'` for house rules where any
 *     opponent-ball contact loses the turn regardless.
 *
 * Path occlusion needs no separate check: the simulator hits whatever is
 * actually in the way first, so a blocked line naturally resolves to a contact
 * with the blocker (a foul if that is the opponent ball) instead of the
 * intended ball.
 *
 * ### Fouls deliberately NOT modelled
 * Cue ball leaving the table, double hits / push shots on frozen balls, and
 * miscues are all outside what single-photo 2D geometry can predict; they are
 * not represented, which makes the engine optimistic on frozen-ball layouts.
 */

import type { Ball, RecognitionResult, Settings, Shot } from '@/lib/types';
import { resolveConfig, type PathCalcConfig } from './config';
import {
  buildFallbackPlan,
  enumerateCandidates,
  selectTopPlans,
  type ShotPlan,
} from './candidates';
import type { ShotSetup } from './simulate';
import { tableBoundsFromGeometry } from './table';

export interface ResolvedLayout {
  cueBall: Ball;
  opponentBall: Ball;
  redBalls: [Ball, Ball];
}

/** Structurally matches `PathCalcResponse` in `lib/uiTypes.ts`. */
export interface PathCalcResult {
  /** Up to `topN` candidates, already ranked — callers must not re-sort. */
  shots: Shot[];
  /** True when `shots` holds a single closest-miss reference shot instead of
   * real recommendations (plan: "유효 후보 0개 시 근접 샷 fallback"). */
  fallback: boolean;
}

/**
 * Split the four recognised balls into their roles.
 *
 * `Settings.cueBallColor` is authoritative when supplied — this is the setting
 * whose misconfiguration makes every recommendation silently wrong, so it wins
 * over whatever `Ball.role` the vision module guessed. Without settings, the
 * `role` field is used instead.
 */
export function resolveLayout(balls: Ball[], settings?: Settings): ResolvedLayout {
  const reds = balls.filter((b) => b.color === 'red1' || b.color === 'red2');
  if (reds.length !== 2) {
    throw new Error(
      `PathCalc requires exactly 2 red balls, got ${reds.length} (colors: ${balls
        .map((b) => b.color)
        .join(', ')})`,
    );
  }

  const whites = balls.filter((b) => b.color === 'white' || b.color === 'yellow');
  if (whites.length !== 2) {
    throw new Error(
      `PathCalc requires exactly one white and one yellow ball, got ${whites.length}`,
    );
  }

  let cueBall: Ball | undefined;
  if (settings) {
    cueBall = whites.find((b) => b.color === settings.cueBallColor);
    if (!cueBall) {
      throw new Error(`No ball matching Settings.cueBallColor='${settings.cueBallColor}'`);
    }
  } else {
    cueBall = whites.find((b) => b.role === 'cueBall');
    if (!cueBall) {
      throw new Error(
        'Cannot determine the cue ball: pass Settings, or set Ball.role="cueBall" on the white/yellow ball',
      );
    }
  }

  const opponentBall = whites.find((b) => b.id !== cueBall.id);
  if (!opponentBall) throw new Error('Cannot determine the opponent ball');

  return { cueBall, opponentBall, redBalls: [reds[0], reds[1]] };
}

/** Assemble the simulator's input from a recognition result. */
export function buildShotSetup(
  recognition: RecognitionResult,
  settings?: Settings,
): ShotSetup {
  const { cueBall, opponentBall, redBalls } = resolveLayout(recognition.balls, settings);
  return { cueBall, opponentBall, redBalls, bounds: tableBoundsFromGeometry(recognition.table) };
}

/**
 * Full engine output, including route polylines for the Phase 3 diagram.
 *
 * Returns at most `topN` rule-valid plans. When none exist, returns exactly one
 * plan with `shot.ruleValid === false` — the closest-miss fallback.
 */
export function computeShotPlans(
  recognition: RecognitionResult,
  settings?: Settings,
  config?: Partial<PathCalcConfig>,
): ShotPlan[] {
  const cfg = resolveConfig(config);
  const setup = buildShotSetup(recognition, settings);
  const recognitionConfidence = recognition.confidence;

  const { plans, bestMiss } = enumerateCandidates(setup, cfg, recognitionConfidence);
  const picked = selectTopPlans(plans, cfg, settings?.skillProfile);
  if (picked.length > 0) return picked;

  if (bestMiss === null) return [];
  return [buildFallbackPlan(setup, bestMiss, cfg, recognitionConfidence)];
}

/** Ranked `Shot` candidates — the shared-contract-only view of the engine. */
export function computeShots(
  recognition: RecognitionResult,
  settings?: Settings,
  config?: Partial<PathCalcConfig>,
): Shot[] {
  return computeShotPlans(recognition, settings, config).map((p) => p.shot);
}

/** Shots plus the fallback flag, shaped for the `/api/path-calc` response. */
export function computePathCalcResult(
  recognition: RecognitionResult,
  settings?: Settings,
  config?: Partial<PathCalcConfig>,
): PathCalcResult {
  const plans = computeShotPlans(recognition, settings, config);
  return {
    shots: plans.map((p) => p.shot),
    fallback: plans.length > 0 && !plans[0].shot.ruleValid,
  };
}

export {
  BALL_DIAMETER_MM,
  BALL_RADIUS_MM,
  DEFAULT_PATHCALC_CONFIG,
  DEFAULT_SPIN_SETTINGS,
  resolveConfig,
} from './config';
export type { OpponentContactPolicy, PathCalcConfig, TipOffset } from './config';
export { initialSpinVelocity, simulateShot, spinVelocityAfter } from './simulate';
export type { ContactEvent, ShotSetup, SimulationResult } from './simulate';
export { tableBoundsFromGeometry } from './table';
export type { TableBounds } from './table';
export { TECHNIQUE_RANK, classifySkillCategory, classifySpin, measureToleranceDeg, personalizedRank } from './candidates';
export type { ShotPlan, SpinLabel } from './candidates';
