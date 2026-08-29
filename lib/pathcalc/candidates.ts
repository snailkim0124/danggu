/**
 * Candidate enumeration, difficulty scoring and ranking.
 *
 * ## Enumeration strategy
 *
 * Rather than analytically solving ghost-ball positions per technique, the
 * engine sweeps the full 360° of aim angle for each spin setting and simulates
 * every sample. This is simpler, and far more robust: obstruction by the
 * opponent ball or the other red, bank routes, and spin routes all fall out of
 * the same simulation, and the technique is *classified from the result* rather
 * than assumed up front.
 *
 * Each maximal contiguous run of scoring aim angles is one candidate. The run's
 * width **is** the angular tolerance the plan asks `difficultyScore` to be
 * based on — no separate tolerance sweep is needed. Run edges are then refined
 * by bisection so the reported tolerance is not quantised to the sweep step.
 *
 * Because ball radii are baked into the simulator, the tolerance window is a
 * real "how far can the aim be off and still score" figure, not a zero-width ray.
 */

import type { ForceLevel, Point, Shot, ShotTechnique, SkillCategory, SkillLevel, SkillProfile } from '@/lib/types';
import type { PathCalcConfig, TipOffset } from './config';
import {
  angleGapDeg,
  clamp,
  clamp01,
  normalizeDeg,
  toDeg,
  toRad,
} from './geometry';
import {
  nearMissPenalty,
  simulateShot,
  type ContactEvent,
  type ShotSetup,
  type SimulationResult,
} from './simulate';

/**
 * A ranked shot plus everything the Phase 3 diagram renderer needs.
 *
 * `Shot` (the shared contract) deliberately carries no path polyline, so the
 * route geometry is surfaced here instead of by widening the shared type.
 */
export interface ShotPlan {
  shot: Shot;
  /** Cue-ball centre polyline in table mm space. */
  path: Point[];
  events: ContactEvent[];
  /** Width of the aim-angle window that still scores, in degrees. */
  toleranceDeg: number;
  simulation: SimulationResult;
}

/** Primary sort key — the fixed 기술 종류 hierarchy from the PRD. `bankShot`
 * ranks last on purpose (not just by cushion count): aiming at a cushion with
 * no ball to reference is hard for every player regardless of self-rated
 * skill, per user feedback — see `personalizedRank`'s doc for how far
 * personalization can move it. This is also the *neutral* ranking: with a
 * fully-neutral `SkillProfile` (every category at level 3), `personalizedRank`
 * below reduces to exactly this. */
export const TECHNIQUE_RANK: Record<ShotTechnique, number> = {
  direct: 0,
  bank1: 1,
  bank2plus: 2,
  bankShot: 3,
};

/** Below this thickness fraction a direct shot counts as `thinCut` (얇게치기);
 * above it, a plain center-ish hit maps to no thickness-based category.
 * Tuned qualitatively, not measured — see plan Phase 5 "고급기술샷 스핀
 * 시뮬레이션 정밀도는 실측 이후 튜닝" for the general expectation that
 * constants like this get retuned once real testing exists. */
const THIN_CUT_MAX_THICKNESS = 0.3;

/** Vertical tip offset beyond which a shot counts as a deliberate draw/follow
 * rather than negligible or side-spin-dominant. */
const SPIN_CATEGORY_MIN_VERTICAL = 0.3;

/** Horizontal (side-spin/회전) tip offset beyond which a shot with no
 * dominant vertical component still counts as a deliberate 회전 shot. */
const SPIN_CATEGORY_MIN_HORIZONTAL = 0.3;

/**
 * Descriptor for a shot's tip-offset (spin), independent of `technique` or
 * aim thickness — `'plain'` covers dead-centre and any tip offset too small
 * to count as deliberate. Exported so the UI can label a shot as e.g.
 * "직접샷(밀어치기)"/"1쿠션(회전)"/"2쿠션 이상(일반)" without duplicating the
 * vertical/horizontal thresholds `classifySkillCategory` already uses.
 */
export type SpinLabel = 'draw' | 'follow' | 'spin' | 'plain';

export function classifySpin(tipOffset: Pick<TipOffset, 'vertical' | 'horizontal'> | undefined): SpinLabel {
  const vertical = tipOffset?.vertical ?? 0;
  const horizontal = tipOffset?.horizontal ?? 0;
  if (vertical <= -SPIN_CATEGORY_MIN_VERTICAL) return 'draw';
  if (vertical >= SPIN_CATEGORY_MIN_VERTICAL) return 'follow';
  if (Math.abs(horizontal) >= SPIN_CATEGORY_MIN_HORIZONTAL) return 'spin';
  return 'plain';
}

/**
 * Map a computed shot back to the one `SkillCategory` (if any) the skill
 * survey's rating should apply to.
 *
 * Priority, mutually exclusive by construction: `technique`-level categories
 * (`bank` from `bankShot`, `multiCushion` from `bank2plus`) take priority,
 * then `tipOffset`-based spin categories (`draw`/`follow`/`spin`, via
 * `classifySpin`) — checked regardless of `technique`, since spin is an
 * independent attribute of any shot now, not its own technique tier — then
 * `thinCut` for a plain `direct` hit with no bank and no dominant spin. A shot
 * can map to no category at all (e.g. a wide, comfortable direct hit, or a
 * plain post-contact `bank1` with no spin), in which case personalization
 * leaves its rank untouched.
 */
export function classifySkillCategory(shot: Pick<Shot, 'technique' | 'aimTarget' | 'tipOffset'>): SkillCategory | null {
  if (shot.technique === 'bankShot') return 'bank';
  if (shot.technique === 'bank2plus') return 'multiCushion';

  const spin = classifySpin(shot.tipOffset);
  if (spin === 'draw') return 'draw';
  if (spin === 'follow') return 'follow';
  if (spin === 'spin') return 'spin';

  if (shot.technique === 'direct' && shot.aimTarget.thickness < THIN_CUT_MAX_THICKNESS) return 'thinCut';
  return null;
}

/**
 * Rank-tier shift applied for a given skill level, in units of
 * `TECHNIQUE_RANK` (whole technique tiers). Level 3 (the default/neutral
 * rating, `DEFAULT_SKILL_PROFILE`) shifts nothing. A user who rates a category
 * a 5 can pull a shot in that category up to a full tier ahead of the fixed
 * hierarchy (e.g. a favourite bank shot ranking with, or ahead of, a direct
 * shot); a 1 pushes it back a full tier. Linear and symmetric around 3 by
 * construction — there's no reason a strong preference should count for more
 * than an equally strong aversion.
 */
function rankShiftForSkillLevel(level: SkillLevel): number {
  return (3 - level) * 0.5;
}

/**
 * Personalized sort key: the fixed technique hierarchy, nudged by the user's
 * self-rated comfort with this specific shot's category. Reduces to plain
 * `TECHNIQUE_RANK[technique]` when `profile` is undefined or every category
 * is at the neutral level 3 — i.e. personalization is strictly additive over
 * the v1 default behaviour, never a replacement for it.
 */
export function personalizedRank(shot: Shot, profile: SkillProfile | undefined): number {
  const base = TECHNIQUE_RANK[shot.technique];
  if (!profile) return base;
  const category = classifySkillCategory(shot);
  if (category === null) return base;
  return base + rankShiftForSkillLevel(profile[category]);
}

function isSpinShot(tip: TipOffset): boolean {
  return Math.abs(tip.vertical) > 1e-6 || Math.abs(tip.horizontal) > 1e-6;
}

/**
 * Classifies purely by the cue ball's cushion contacts — spin plays no part.
 * A draw/follow/회전 shot that happens to need zero cushions is `'direct'`,
 * one that banks once after contact is `'bank1'`, exactly like a plain
 * center-ball shot; the spin is still reported via `Shot.tipOffset`. See the
 * module doc on `ShotTechnique` in `lib/types.ts` for why technique and spin
 * were split into independent attributes.
 */
function classifyTechnique(sim: SimulationResult): ShotTechnique {
  // A cushion before the cue ball has touched ANY ball at all is 뱅크샷
  // (빈쿠션치기/가락) — aiming at a cushion with no ball to reference — which
  // reads as a materially different, harder shot than banking off *after* a
  // contact, even when the raw cushion count is the same. Checked ahead of
  // the post-contact cushion count below so a shot that banks both before
  // *and* after first contact is still labelled by the harder property.
  if (sim.cushionsAtFirstBallContact > 0) return 'bankShot';
  const cushions =
    sim.cushionsBeforeScore >= 0 ? sim.cushionsBeforeScore : sim.cushionsAtFirstBallContact;
  if (cushions === 0) return 'direct';
  if (cushions === 1) return 'bank1';
  return 'bank2plus';
}

function forceLevelFor(sim: SimulationResult, longSideMm: number, cfg: PathCalcConfig): ForceLevel {
  // The stroke only has to be strong enough to complete the score; whatever
  // rollout happens afterwards is not something the player aims for.
  const effort = sim.effortAtScoreMm >= 0 ? sim.effortAtScoreMm : sim.effortMm;
  const ratio = effort / Math.max(longSideMm, 1);
  let level = 1;
  for (const threshold of cfg.forceLevelThresholdsTableLengths) {
    if (ratio > threshold) level += 1;
  }
  return clamp(level, 1, 5) as ForceLevel;
}

/**
 * Confidence floor: the angular tolerance below which a recommendation is
 * indistinguishable from recognition noise.
 *
 * A ball-position error of ε at distance L to the first object ball shifts the
 * required aim by roughly ε/L radians. Both the cue ball and the object ball
 * carry that error independently, so they add in quadrature: √2·ε/L. Clamped
 * into a sane range — this correctly tightens the floor for long shots and
 * raises it for close ones, where the same mm error spans far more angle.
 */
function confidenceFloorDeg(sim: SimulationResult, cfg: PathCalcConfig, longSideMm: number): number {
  const l = Math.max(sim.firstContactDistanceMm ?? longSideMm, 1);
  return clamp(
    toDeg((Math.SQRT2 * cfg.recognitionErrorMm) / l),
    cfg.confidenceFloorMinDeg,
    cfg.confidenceFloorMaxDeg,
  );
}

function buildShotPlan(
  setup: ShotSetup,
  tip: TipOffset,
  aimRad: number,
  toleranceDeg: number,
  sim: SimulationResult,
  cfg: PathCalcConfig,
  recognitionConfidence: number,
): ShotPlan {
  const technique = classifyTechnique(sim);
  const angleDeg = normalizeDeg(toDeg(aimRad));

  // difficultyScore: 0 (razor-thin) .. 1 (comfortably wide), saturating at
  // `easyToleranceDeg`. Higher = easier, matching `Shot.difficultyScore`'s
  // "Lower = harder (narrower tolerance window)" contract note.
  const difficultyScore = clamp01(toleranceDeg / cfg.easyToleranceDeg);

  const floorDeg = confidenceFloorDeg(sim, cfg, setup.bounds.longSideMm);
  let confidence = clamp01(
    (toleranceDeg - floorDeg) / Math.max(1e-6, cfg.confidenceFullDeg - floorDeg),
  );
  confidence *= cfg.techniqueFidelity[technique];
  confidence *= clamp01(recognitionConfidence);
  // Soft down-rank (never a hard filter — see simulate.ts's "Kiss risk" doc)
  // for a struck ball's projected path passing close to a ball nobody aimed
  // for. `1` when there's no such risk, so this is a no-op for every shot
  // that isn't near another ball.
  confidence *= sim.kissRiskMultiplier;

  const spinTag = isSpinShot(tip)
    ? `v${tip.vertical.toFixed(1)}h${tip.horizontal.toFixed(1)}`
    : 'c';

  const shot: Shot = {
    id: `${technique}-${spinTag}-${angleDeg.toFixed(1)}`,
    technique,
    aimTarget: { thickness: sim.firstThickness ?? 0 },
    angleDeg,
    forceLevel: forceLevelFor(sim, setup.bounds.longSideMm, cfg),
    tipOffset: { vertical: tip.vertical, horizontal: tip.horizontal },
    sequence: [setup.cueBall.id, ...sim.redsContacted],
    difficultyScore,
    ruleValid: sim.ruleValid,
    confidence,
  };

  return { shot, path: sim.path, events: sim.events, toleranceDeg, simulation: sim };
}

/** Maximal contiguous runs of `true`, treating the array as circular. */
function findRuns(ok: boolean[]): Array<[number, number]> {
  const n = ok.length;
  if (n === 0) return [];
  if (ok.every(Boolean)) return [[0, n - 1]];

  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    if (ok[(i - 1 + n) % n]) continue; // not a run start
    let end = i;
    while (ok[(end + 1) % n] && end - i < n - 1) end += 1;
    runs.push([i, end]); // `end` may exceed n-1 when the run wraps
  }
  return runs;
}

/** Bisect toward the true boundary, returning the innermost known-good angle. */
function refineEdge(
  setup: ShotSetup,
  tip: TipOffset,
  cfg: PathCalcConfig,
  goodRad: number,
  badRad: number,
): number {
  let good = goodRad;
  let bad = badRad;
  for (let i = 0; i < cfg.bisectIterations; i++) {
    const mid = (good + bad) / 2;
    if (simulateShot(setup, mid, tip, cfg).ruleValid) good = mid;
    else bad = mid;
  }
  return good;
}

interface SweepOutcome {
  plans: ShotPlan[];
  /** Lowest-penalty non-scoring sample seen anywhere, for the fallback. */
  bestMiss: { aimRad: number; tip: TipOffset; sim: SimulationResult; penalty: number } | null;
}

/** Sweep every configured spin setting and collect refined candidates. */
export function enumerateCandidates(
  setup: ShotSetup,
  cfg: PathCalcConfig,
  recognitionConfidence: number,
): SweepOutcome {
  const samples = Math.max(8, Math.round(360 / cfg.coarseStepDeg));
  const stepRad = (2 * Math.PI) / samples;
  const plans: ShotPlan[] = [];
  let bestMiss: SweepOutcome['bestMiss'] = null;

  for (const tip of cfg.spinSettings) {
    const ok: boolean[] = new Array(samples);
    for (let i = 0; i < samples; i++) {
      const sim = simulateShot(setup, i * stepRad, tip, cfg);
      ok[i] = sim.ruleValid;
      if (!sim.ruleValid) {
        const penalty = nearMissPenalty(sim, cfg);
        if (bestMiss === null || penalty < bestMiss.penalty) {
          bestMiss = { aimRad: i * stepRad, tip, sim, penalty };
        }
      }
    }

    for (const [start, end] of findRuns(ok)) {
      let lo: number;
      let hi: number;
      let toleranceDeg: number;

      if (end - start >= samples - 1) {
        // Degenerate: every aim angle scores. Nothing to refine.
        lo = 0;
        hi = 2 * Math.PI;
        toleranceDeg = 360;
      } else {
        lo = refineEdge(setup, tip, cfg, start * stepRad, (start - 1) * stepRad);
        hi = refineEdge(setup, tip, cfg, end * stepRad, (end + 1) * stepRad);
        toleranceDeg = toDeg(hi - lo);
      }

      const centerRad = (lo + hi) / 2;
      const sim = simulateShot(setup, centerRad, tip, cfg);
      // The refined centre must still be a scoring shot; if a pathological
      // window makes it not so, drop the candidate rather than recommend it.
      if (!sim.ruleValid) continue;
      plans.push(
        buildShotPlan(setup, tip, centerRad, toleranceDeg, sim, cfg, recognitionConfidence),
      );
    }
  }

  return { plans, bestMiss };
}

/**
 * Rank and thin the candidate list.
 *
 * Sorted by technique (the fixed hierarchy, personalized by `skillProfile` if
 * given — see `personalizedRank`) then by descending `difficultyScore`, and
 * de-duplicated by aim angle: two candidates whose aim angles are within
 * `duplicateAngleDeg` are the same stroke as far as the player is concerned,
 * so only the first — which, given the sort order, is the one using the
 * simplest/best-ranked technique — survives.
 */
export function selectTopPlans(
  plans: ShotPlan[],
  cfg: PathCalcConfig,
  skillProfile?: SkillProfile,
): ShotPlan[] {
  const sorted = [...plans].sort(
    (a, b) =>
      personalizedRank(a.shot, skillProfile) - personalizedRank(b.shot, skillProfile) ||
      b.shot.difficultyScore - a.shot.difficultyScore ||
      a.shot.angleDeg - b.shot.angleDeg,
  );

  const picked: ShotPlan[] = [];
  for (const plan of sorted) {
    const duplicate = picked.some(
      (p) => angleGapDeg(p.shot.angleDeg, plan.shot.angleDeg) < cfg.duplicateAngleDeg,
    );
    if (duplicate) continue;
    picked.push(plan);
    if (picked.length >= cfg.topN) break;
  }
  return picked;
}

/**
 * Build the reference shot shown when no rule-valid candidate exists at all.
 *
 * Marked `ruleValid: false` and capped at a low confidence — the UI must
 * present it as "closest miss, for reference", never as a recommendation.
 */
export function buildFallbackPlan(
  setup: ShotSetup,
  best: NonNullable<SweepOutcome['bestMiss']>,
  cfg: PathCalcConfig,
  recognitionConfidence: number,
): ShotPlan {
  const { sim, tip, aimRad } = best;
  const technique = classifyTechnique(sim);
  const angleDeg = normalizeDeg(toDeg(aimRad));
  const closeness = clamp01(1 - sim.missDistanceMm / cfg.nearMissScaleMm);
  const confidence =
    (sim.foul ? 0 : closeness) *
    cfg.nearMissConfidenceCap *
    clamp01(recognitionConfidence) *
    sim.kissRiskMultiplier;

  const shot: Shot = {
    id: `nearmiss-${technique}-${angleDeg.toFixed(1)}`,
    technique,
    aimTarget: { thickness: sim.firstThickness ?? 0 },
    angleDeg,
    forceLevel: forceLevelFor(sim, setup.bounds.longSideMm, cfg),
    tipOffset: { vertical: tip.vertical, horizontal: tip.horizontal },
    sequence: [setup.cueBall.id, ...sim.redsContacted],
    difficultyScore: 0,
    ruleValid: false,
    confidence,
  };

  return { shot, path: sim.path, events: sim.events, toleranceDeg: 0, simulation: sim };
}

/** Convenience for tests/tuning: tolerance window around one specific aim. */
export function measureToleranceDeg(
  setup: ShotSetup,
  tip: TipOffset,
  aimRad: number,
  cfg: PathCalcConfig,
): number {
  if (!simulateShot(setup, aimRad, tip, cfg).ruleValid) return 0;
  const stepRad = toRad(cfg.coarseStepDeg);
  let lowBad = aimRad;
  let highBad = aimRad;
  const limit = Math.PI;
  while (lowBad > aimRad - limit && simulateShot(setup, lowBad, tip, cfg).ruleValid) {
    lowBad -= stepRad;
  }
  while (highBad < aimRad + limit && simulateShot(setup, highBad, tip, cfg).ruleValid) {
    highBad += stepRad;
  }
  const lo = refineEdge(setup, tip, cfg, lowBad + stepRad, lowBad);
  const hi = refineEdge(setup, tip, cfg, highBad - stepRad, highBad);
  return toDeg(hi - lo);
}
