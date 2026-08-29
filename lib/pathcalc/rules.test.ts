/**
 * Hard rule-filter tests for the 4구(사구) Path Calculation engine.
 *
 * Plan verification step: "규칙 필터 단위 테스트: 상대공 접촉/한쪽만 접촉하는
 * 경로가 후보에서 제외되는지 확인" and "유효 후보 0개 배치에서 근접 샷
 * fallback이 표시되는지 확인".
 *
 * Everything here uses hand-built coordinate fixtures — no vision pipeline.
 */

import { describe, expect, it } from 'vitest';
import {
  buildShotSetup,
  computePathCalcResult,
  computeShotPlans,
  simulateShot,
  TECHNIQUE_RANK,
} from './index';
import { enumerateCandidates } from './candidates';
import { DEFAULT_PATHCALC_CONFIG } from './config';
import { toRad } from './geometry';
import {
  BALL_IDS,
  BANK_SHOT_LAYOUT,
  CLUSTERED_LAYOUT,
  NO_SOLUTION_LAYOUT,
  OPEN_LAYOUT,
  OPPONENT_SCREEN_LAYOUT,
  WHITE_CUE_SETTINGS,
  makeRecognition,
} from './fixtures';

const CFG = DEFAULT_PATHCALC_CONFIG;
const CENTER = { vertical: 0, horizontal: 0 };

describe('rule filter: opponent-ball contact', () => {
  it('rejects a shot that contacts the opponent ball first', () => {
    // Cue, opponent and red1 are collinear along +x, so aiming at 0° drives
    // the cue ball straight into the opponent ball before it reaches any red.
    const setup = buildShotSetup(OPPONENT_SCREEN_LAYOUT, WHITE_CUE_SETTINGS);
    const sim = simulateShot(setup, 0, CENTER, CFG);

    expect(sim.events[0]).toMatchObject({ kind: 'ball', ballId: BALL_IDS.opponent });
    expect(sim.opponentContactedBeforeScore).toBe(true);
    expect(sim.foul).toBe(true);
    expect(sim.ruleValid).toBe(false);
  });

  it('never returns a candidate whose route touches the opponent ball before scoring', () => {
    for (const layout of [OPEN_LAYOUT, CLUSTERED_LAYOUT, OPPONENT_SCREEN_LAYOUT]) {
      const plans = computeShotPlans(layout, WHITE_CUE_SETTINGS);
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) {
        expect(plan.shot.ruleValid).toBe(true);
        expect(plan.simulation.opponentContactedBeforeScore).toBe(false);
        expect(plan.simulation.foul).toBe(false);
        // The ball ids in contact order must never lead with the opponent.
        expect(plan.shot.sequence).not.toContain(BALL_IDS.opponent);
      }
    }
  });

  it('excludes a route that clears both reds but then fouls during rollout', () => {
    const setup = buildShotSetup(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    const sim = simulateShot(setup, toRad(22.1), CENTER, CFG);
    expect(sim.ruleValid).toBe(true);

    // Re-run the identical stroke under the strict house rule, with the
    // opponent ball dropped onto the cue ball's post-score path.
    const afterScore = sim.path[sim.path.length - 1];
    const strictLayout = makeRecognition({
      cue: { x: 600, y: 400 },
      opponent: afterScore,
      red1: { x: 1000, y: 600 },
      red2: { x: 1400, y: 380 },
    });
    const strictSetup = buildShotSetup(strictLayout, WHITE_CUE_SETTINGS);
    const strictSim = simulateShot(strictSetup, toRad(22.1), CENTER, {
      ...CFG,
      opponentContactPolicy: 'strict',
    });
    expect(strictSim.opponentContactedAfterScore).toBe(true);
    expect(strictSim.foul).toBe(true);
    expect(strictSim.ruleValid).toBe(false);
  });
});

describe('rule filter: both reds must be contacted', () => {
  it('rejects a shot that only contacts one red ball', () => {
    // Red2 is parked far away in the opposite corner; a gentle straight hit on
    // red1 sends the cue ball nowhere near it.
    const layout = makeRecognition({
      cue: { x: 400, y: 300 },
      opponent: { x: 2400, y: 1200 },
      red1: { x: 700, y: 300 },
      red2: { x: 2400, y: 200 },
    });
    const setup = buildShotSetup(layout, WHITE_CUE_SETTINGS);
    const sim = simulateShot(setup, 0, CENTER, { ...CFG, maxTravelTableLengths: 0.4 });

    expect(sim.redsContacted).toEqual([BALL_IDS.red1]);
    expect(sim.scored).toBe(false);
    expect(sim.ruleValid).toBe(false);
    expect(sim.missDistanceMm).toBeGreaterThan(0);
  });

  it('requires every returned candidate to have contacted both reds', () => {
    for (const layout of [OPEN_LAYOUT, CLUSTERED_LAYOUT]) {
      for (const plan of computeShotPlans(layout, WHITE_CUE_SETTINGS)) {
        expect(plan.simulation.scored).toBe(true);
        expect(plan.simulation.redsContacted).toHaveLength(2);
        expect([...plan.simulation.redsContacted].sort()).toEqual([
          BALL_IDS.red1,
          BALL_IDS.red2,
        ]);
        // sequence is [cueBallId, firstRed, secondRed] per the Shot contract.
        expect(plan.shot.sequence[0]).toBe(BALL_IDS.cue);
        expect(plan.shot.sequence).toHaveLength(3);
      }
    }
  });
});

describe('rule filter: obstruction', () => {
  it('excludes a direct shot once the opponent ball is dropped onto its path', () => {
    // Start from a real solution the engine found on an open table...
    const plans = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    const direct = plans.find((p) => p.shot.technique === 'direct');
    expect(direct).toBeDefined();
    const aimRad = toRad(direct!.shot.angleDeg);

    const clearSetup = buildShotSetup(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    expect(simulateShot(clearSetup, aimRad, CENTER, CFG).ruleValid).toBe(true);

    // ...then place the opponent ball squarely on the cue ball's approach line.
    const cue = { x: 600, y: 400 };
    const blocker = {
      x: cue.x + 200 * Math.cos(aimRad),
      y: cue.y + 200 * Math.sin(aimRad),
    };
    const blockedLayout = makeRecognition({
      cue,
      opponent: blocker,
      red1: { x: 1000, y: 600 },
      red2: { x: 1400, y: 380 },
    });
    const blockedSim = simulateShot(
      buildShotSetup(blockedLayout, WHITE_CUE_SETTINGS),
      aimRad,
      CENTER,
      CFG,
    );

    expect(blockedSim.events[0]).toMatchObject({ kind: 'ball', ballId: BALL_IDS.opponent });
    expect(blockedSim.ruleValid).toBe(false);

    // And the engine must not offer that blocked line as a candidate any more.
    for (const plan of computeShotPlans(blockedLayout, WHITE_CUE_SETTINGS)) {
      if (!plan.shot.ruleValid) continue;
      expect(Math.abs(plan.shot.angleDeg - direct!.shot.angleDeg)).toBeGreaterThan(0.5);
    }
  });

  it('still scores when the blocker on the line is the other red ball', () => {
    // An intervening red is not a foul — it just changes which red is hit first.
    const layout = makeRecognition({
      cue: { x: 400, y: 635 },
      opponent: { x: 2400, y: 200 },
      red1: { x: 1200, y: 635 },
      red2: { x: 800, y: 635 },
    });
    const sim = simulateShot(buildShotSetup(layout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);
    expect(sim.events[0]).toMatchObject({ kind: 'ball', ballId: BALL_IDS.red2 });
    expect(sim.opponentContactedBeforeScore).toBe(false);
  });
});

describe('near-miss fallback', () => {
  it('returns a single closest-miss reference shot when no valid shot exists', () => {
    const plans = computeShotPlans(NO_SOLUTION_LAYOUT, WHITE_CUE_SETTINGS);

    expect(plans).toHaveLength(1);
    expect(plans[0].shot.ruleValid).toBe(false);
    expect(plans[0].shot.difficultyScore).toBe(0);
    expect(plans[0].shot.confidence).toBeLessThanOrEqual(CFG.nearMissConfidenceCap);
    expect(plans[0].shot.id).toMatch(/^nearmiss-/);

    const result = computePathCalcResult(NO_SOLUTION_LAYOUT, WHITE_CUE_SETTINGS);
    expect(result.fallback).toBe(true);
    expect(result.shots).toHaveLength(1);
  });

  it('does not flag fallback when real candidates exist', () => {
    const result = computePathCalcResult(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    expect(result.fallback).toBe(false);
    expect(result.shots.every((s) => s.ruleValid)).toBe(true);
  });

  it('picks a legal near-miss over a fouling route', () => {
    // A stroke budget too short to reach both reds leaves only misses; the
    // fallback must still avoid the opponent ball where it can.
    const plans = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS, {
      maxTravelTableLengths: 0.18,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].shot.ruleValid).toBe(false);
    expect(plans[0].simulation.foul).toBe(false);
  });
});

describe('cue ball role resolution', () => {
  it('follows Settings.cueBallColor rather than the recognised role', () => {
    const yellowCue = computeShotPlans(OPEN_LAYOUT, {
      cueBallColor: 'yellow',
      tableSize: '대대',
    });
    for (const plan of yellowCue) {
      expect(plan.shot.sequence[0]).toBe(BALL_IDS.opponent); // the yellow ball
    }
    // The white-cue reading of the same table is a different set of shots.
    const whiteCue = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    expect(whiteCue[0].shot.sequence[0]).toBe(BALL_IDS.cue);
  });

  it('falls back to Ball.role when no Settings are supplied', () => {
    // This is exactly how app/api/path-calc/route.ts calls the engine: the
    // request envelope carries no Settings, so roles come from the recognition.
    const plans = computeShotPlans(OPEN_LAYOUT);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.shot.sequence[0]).toBe(BALL_IDS.cue);
    }
    expect(plans.map((p) => p.shot.id)).toEqual(
      computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS).map((p) => p.shot.id),
    );
  });

  it('rejects a layout that is not 2 reds + white + yellow', () => {
    const broken = makeRecognition({
      cue: { x: 400, y: 300 },
      opponent: { x: 900, y: 300 },
      red1: { x: 1200, y: 300 },
      red2: { x: 1500, y: 300 },
    });
    broken.balls = broken.balls.slice(0, 3);
    expect(() => computeShotPlans(broken, WHITE_CUE_SETTINGS)).toThrow(/2 red balls/);
  });
});

describe('technique classification: bankShot (뱅크샷/빈쿠션치기) vs N쿠션', () => {
  // Uses the full candidate set (`enumerateCandidates`), not
  // `computeShotPlans`'s top-3 — bankShot now correctly ranks *behind* an
  // easier bank1/bank2plus alternative when the sweep finds one via a spin
  // setting (exactly the "뱅크샷은 누구나 치기 어려운 샷이니 우선순위를 뒤로"
  // behaviour asked for), so BANK_SHOT_LAYOUT's actual top-3 isn't guaranteed
  // to contain a bankShot even though the sweep still generates (and
  // correctly labels) plenty of them. Classification correctness is
  // independent of which candidates survive the final ranking cut.
  const setup = buildShotSetup(BANK_SHOT_LAYOUT, WHITE_CUE_SETTINGS);
  const { plans: allBankShotLayoutCandidates } = enumerateCandidates(
    setup,
    CFG,
    BANK_SHOT_LAYOUT.confidence,
  );

  it('labels a cushion-before-any-ball-contact route as bankShot, not bank1/bank2plus', () => {
    const bankShots = allBankShotLayoutCandidates.filter((p) => p.shot.technique === 'bankShot');
    expect(bankShots.length).toBeGreaterThan(0);
  });

  it('never labels a scoring cushion-first route as bank1 or bank2plus', () => {
    // The distinguishing property is *when* the cushion happens relative to
    // the first ball contact, not the total cushion count — so a cushion-
    // first route must never be mislabeled as the ball-first "N쿠션" buckets.
    for (const plan of allBankShotLayoutCandidates) {
      if (plan.simulation.cushionsAtFirstBallContact > 0) {
        expect(plan.shot.technique).toBe('bankShot');
      }
    }
  });

  it('ranks an available bank1/bank2plus alternative ahead of bankShot in the final top-3', () => {
    // The concrete instance of the above: this layout's sweep finds a
    // spin-assisted bank1/bank2plus route (a direct first-ball contact,
    // previously mislabelled "advanced" and buried behind bankShot before
    // technique and spin were split apart), so the top-3 should prefer it.
    const plans = computeShotPlans(BANK_SHOT_LAYOUT, WHITE_CUE_SETTINGS);
    expect(plans.some((p) => p.shot.technique === 'bank1' || p.shot.technique === 'bank2plus')).toBe(
      true,
    );
    expect(TECHNIQUE_RANK[plans[0].shot.technique]).toBeLessThan(TECHNIQUE_RANK.bankShot);
  });

  it('still classifies OPEN_LAYOUT\'s ball-first bank route as bank1/bank2plus, not bankShot', () => {
    // Sanity check the split doesn't over-fire: a layout with a clear direct
    // line (no cushion needed before the first contact) should keep using
    // the plain N쿠션 labels for any bank candidates it does produce.
    const plans = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    for (const plan of plans) {
      if (plan.shot.technique === 'bank1' || plan.shot.technique === 'bank2plus') {
        expect(plan.simulation.cushionsAtFirstBallContact).toBe(0);
      }
    }
  });
});
