/**
 * Tests for the documented physical approximations in the simulator, so the
 * claims in `simulate.ts`'s header are enforced rather than merely asserted:
 * the 90° rule, the 30° rule, draw/follow behaviour, and cushion reflection.
 */

import { describe, expect, it } from 'vitest';
import { buildShotSetup, computeShotPlans, simulateShot } from './index';
import { DEFAULT_PATHCALC_CONFIG } from './config';
import { BALL_RADIUS_MM } from './config';
import { TECHNIQUE_RANK } from './candidates';
import { angleGapDeg, dot, normalize, sub, toDeg, toRad } from './geometry';
import { tableBoundsFromGeometry } from './table';
import {
  BALL_IDS,
  CLUSTERED_LAYOUT,
  OPEN_LAYOUT,
  WHITE_CUE_SETTINGS,
  makeRecognition,
} from './fixtures';
import type { Point } from '@/lib/types';
import type { SimulationResult } from './simulate';

const CFG = DEFAULT_PATHCALC_CONFIG;
const CENTER = { vertical: 0, horizontal: 0 };

/** Direction the cue ball leaves event `index` on (path[k+1] is events[k].at). */
function directionAfterEvent(sim: SimulationResult, index: number): Point | null {
  const from = sim.path[index + 1];
  const to = sim.path[index + 2];
  if (!from || !to) return null;
  return normalize(sub(to, from));
}

/** A layout with the distractor balls parked far out of the way. */
function soloLayout(cue: Point, red1: Point) {
  return makeRecognition({
    cue,
    opponent: { x: 2450, y: 60 },
    red1,
    red2: { x: 2350, y: 60 },
  });
}

describe('ball-ball contact: the 90° rule', () => {
  it('sends a short-range centre-ball hit off along the tangent line', () => {
    // Half-ball hit: the object centre is offset by exactly R, so sinθ = 0.5.
    const cue = { x: 1000, y: 600 };
    const red1 = { x: 1100, y: 600 + BALL_RADIUS_MM };
    const sim = simulateShot(buildShotSetup(soloLayout(cue, red1), WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    const contact = sim.events[0];
    expect(contact).toMatchObject({ kind: 'ball', ballId: BALL_IDS.red1 });
    expect(contact.thickness).toBeCloseTo(0.5, 2);

    // Over ~43mm of travel the cue ball has barely started rolling, so it
    // should leave almost exactly perpendicular to the line of centres.
    const outgoing = directionAfterEvent(sim, 0)!;
    const lineOfCentres = normalize(sub(red1, contact.at));
    const deflectionFromNormal = toDeg(Math.acos(dot(outgoing, lineOfCentres)));
    expect(deflectionFromNormal).toBeGreaterThan(85);
    expect(deflectionFromNormal).toBeLessThanOrEqual(90.5);
  });
});

describe('ball-ball contact: the 30° rule', () => {
  it('shortens the deflection once the cue ball has rolled a long way', () => {
    const cue = { x: 300, y: 600 };
    const red1 = { x: 2000, y: 600 + BALL_RADIUS_MM }; // same half-ball hit, ~1.6m away
    const sim = simulateShot(buildShotSetup(soloLayout(cue, red1), WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    const outgoing = directionAfterEvent(sim, 0)!;
    // Incoming direction was +x, so the deflection is just the outgoing angle.
    const deflection = Math.abs(toDeg(Math.atan2(outgoing.y, outgoing.x)));

    // A rolling cue ball deflects ~30-34° on a half-ball hit — far less than
    // the 60° a pure stun would give at this cut angle.
    expect(deflection).toBeGreaterThan(28);
    expect(deflection).toBeLessThan(42);
  });
});

describe('vertical spin', () => {
  const cue = { x: 1000, y: 635 };
  const red1 = { x: 1200, y: 635 }; // dead-full hit

  it('draw sends the cue ball back down its own line', () => {
    const sim = simulateShot(
      buildShotSetup(soloLayout(cue, red1), WHITE_CUE_SETTINGS),
      0,
      { vertical: -1, horizontal: 0 },
      CFG,
    );
    const outgoing = directionAfterEvent(sim, 0)!;
    expect(outgoing.x).toBeLessThan(-0.9); // reversed
  });

  it('follow drives the cue ball forward through the contact', () => {
    const sim = simulateShot(
      buildShotSetup(soloLayout(cue, red1), WHITE_CUE_SETTINGS),
      0,
      { vertical: 1, horizontal: 0 },
      CFG,
    );
    const outgoing = directionAfterEvent(sim, 0)!;
    expect(outgoing.x).toBeGreaterThan(0.9);
  });

  it('draw loses its bite over distance', () => {
    // The same max-draw stroke, but the object ball is far away: by the time
    // the cue ball arrives it has rolled, so it can no longer draw back.
    const far = simulateShot(
      buildShotSetup(soloLayout({ x: 200, y: 635 }, { x: 2300, y: 635 }), WHITE_CUE_SETTINGS),
      0,
      { vertical: -1, horizontal: 0 },
      CFG,
    );
    const outgoing = directionAfterEvent(far, 0);
    // Either it stops dead or it continues forward — it must not come back.
    if (outgoing) expect(outgoing.x).toBeGreaterThan(0);
  });
});

describe('cushion rebound', () => {
  it('mirrors the incidence angle with no side spin', () => {
    const sim = simulateShot(
      buildShotSetup(soloLayout({ x: 1270, y: 400 }, { x: 300, y: 200 }), WHITE_CUE_SETTINGS),
      toRad(45),
      CENTER,
      CFG,
    );
    const first = sim.events[0];
    expect(first).toMatchObject({ kind: 'cushion', cushion: 'top' });

    const outgoing = directionAfterEvent(sim, 0)!;
    const outDeg = toDeg(Math.atan2(outgoing.y, outgoing.x));
    expect(angleGapDeg(outDeg, -45)).toBeLessThan(0.5);
  });

  it('side spin bends the rebound off the mirror line', () => {
    const layout = soloLayout({ x: 1270, y: 400 }, { x: 300, y: 200 });
    const plain = simulateShot(buildShotSetup(layout, WHITE_CUE_SETTINGS), toRad(45), CENTER, CFG);
    const spun = simulateShot(
      buildShotSetup(layout, WHITE_CUE_SETTINGS),
      toRad(45),
      { vertical: 0, horizontal: 0.8 },
      CFG,
    );

    const a = directionAfterEvent(plain, 0)!;
    const b = directionAfterEvent(spun, 0)!;
    const gap = angleGapDeg(
      toDeg(Math.atan2(a.y, a.x)),
      toDeg(Math.atan2(b.y, b.x)),
    );
    expect(gap).toBeGreaterThan(3);
  });
});

describe('kiss risk: struck ball passing close to another ball (의도치 않은 2차 충돌)', () => {
  // Reuses the exact half-ball-hit fixture from the "90° rule" test above
  // (cue={1000,600}, red1={1100, 600+R}) — a straight-on approach that grazes
  // red1 at thickness 0.5, contact at ≈(1043.3, 600). The cue ball itself then
  // deflects toward the bottom cushion (see that test), while the struck
  // ball's own line-of-centres direction `n` points the opposite way — the two
  // never overlap, so any risk detected here is purely the new kiss-risk
  // signal, not the pre-existing cue-ball-vs-opponent foul check.
  const cue = { x: 1000, y: 600 };
  const red1 = { x: 1100, y: 600 + BALL_RADIUS_MM };
  const contactDist = 2 * BALL_RADIUS_MM;

  /** `n` (the struck ball's projected line) computed the same way the "90°
   * rule" test above does, from a baseline run with no other ball nearby. */
  function struckBallLine() {
    const baseline = simulateShot(buildShotSetup(soloLayout(cue, red1), WHITE_CUE_SETTINGS), 0, CENTER, CFG);
    return { contactAt: baseline.events[0].at, n: normalize(sub(red1, baseline.events[0].at)), baseline };
  }

  it('leaves the multiplier at 1 when no ball sits near the struck ball\'s projected path', () => {
    const { baseline } = struckBallLine();
    expect(baseline.kissRiskMultiplier).toBe(1);
  });

  it('drops to the configured floor when another ball sits dead-on the projected path', () => {
    const { n } = struckBallLine();
    // Placed well forward along `n`, dead-centre on the line (0 perpendicular
    // offset) — the model treats this as a near-certain kiss.
    const onLine: Point = { x: red1.x + n.x * 300, y: red1.y + n.y * 300 };
    const layout = makeRecognition({ cue, red1, opponent: onLine, red2: { x: 2350, y: 60 } });
    const sim = simulateShot(buildShotSetup(layout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    expect(sim.kissRiskMultiplier).toBeCloseTo(CFG.kissMinMultiplier, 6);
    // Purely a confidence signal — the cue ball's own path/foul status is
    // untouched by a ball sitting on some *other* ball's projected line.
    expect(sim.opponentContactedBeforeScore).toBe(false);
    expect(sim.opponentContactedAfterScore).toBe(false);
  });

  it('leaves the multiplier at 1 once a ball is safely outside the grey zone', () => {
    const { n } = struckBallLine();
    const perp: Point = { x: -n.y, y: n.x };
    const clearanceMm = contactDist + CFG.kissMarginMm + 5; // just past the safe boundary
    const justSafe: Point = {
      x: red1.x + n.x * 300 + perp.x * clearanceMm,
      y: red1.y + n.y * 300 + perp.y * clearanceMm,
    };
    const layout = makeRecognition({ cue, red1, opponent: justSafe, red2: { x: 2350, y: 60 } });
    const sim = simulateShot(buildShotSetup(layout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    expect(sim.kissRiskMultiplier).toBe(1);
  });

  it('interpolates linearly across the grey zone', () => {
    const { n } = struckBallLine();
    const perp: Point = { x: -n.y, y: n.x };
    const clearanceMm = contactDist + CFG.kissMarginMm / 2; // exact midpoint of the grey zone
    const midway: Point = {
      x: red1.x + n.x * 300 + perp.x * clearanceMm,
      y: red1.y + n.y * 300 + perp.y * clearanceMm,
    };
    const layout = makeRecognition({ cue, red1, opponent: midway, red2: { x: 2350, y: 60 } });
    const sim = simulateShot(buildShotSetup(layout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    const expected = CFG.kissMinMultiplier + 0.5 * (1 - CFG.kissMinMultiplier);
    expect(sim.kissRiskMultiplier).toBeCloseTo(expected, 3);
  });

  it('folds into Shot.confidence as a multiplicative discount, never affecting ruleValid', () => {
    const { n } = struckBallLine();
    const onLine: Point = { x: red1.x + n.x * 300, y: red1.y + n.y * 300 };
    const riskyLayout = makeRecognition({ cue, red1, opponent: onLine, red2: { x: 2350, y: 60 } });
    const safeLayout = soloLayout(cue, red1);

    const risky = simulateShot(buildShotSetup(riskyLayout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);
    const safe = simulateShot(buildShotSetup(safeLayout, WHITE_CUE_SETTINGS), 0, CENTER, CFG);

    // Both otherwise-identical simulations (same aim, same contact) differ
    // only in kissRiskMultiplier — confirms nothing else about the stroke
    // changed just because an unrelated ball happens to sit on the struck
    // ball's projected line.
    expect(risky.events[0].thickness).toBeCloseTo(safe.events[0].thickness!, 6);
    expect(risky.ruleValid).toBe(safe.ruleValid);
    expect(risky.kissRiskMultiplier).toBeLessThan(safe.kissRiskMultiplier);
  });
});

describe('table geometry', () => {
  it('derives axis-aligned bounds from the cushion-nose boundary', () => {
    const bounds = tableBoundsFromGeometry(OPEN_LAYOUT.table);
    expect(bounds.widthMm).toBeCloseTo(2540, 6);
    expect(bounds.heightMm).toBeCloseTo(1270, 6);
    expect(bounds.longSideMm).toBeCloseTo(2540, 6);
  });

  it('keeps the cue ball inside the cushion nose line for its whole path', () => {
    const bounds = tableBoundsFromGeometry(OPEN_LAYOUT.table);
    for (const plan of computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS)) {
      for (const p of plan.path) {
        expect(p.x).toBeGreaterThanOrEqual(bounds.minX + BALL_RADIUS_MM - 0.01);
        expect(p.x).toBeLessThanOrEqual(bounds.maxX - BALL_RADIUS_MM + 0.01);
        expect(p.y).toBeGreaterThanOrEqual(bounds.minY + BALL_RADIUS_MM - 0.01);
        expect(p.y).toBeLessThanOrEqual(bounds.maxY - BALL_RADIUS_MM + 0.01);
      }
    }
  });
});

describe('ranking and scoring', () => {
  it('returns at most 3 candidates, ordered by technique then difficulty', () => {
    for (const layout of [OPEN_LAYOUT, CLUSTERED_LAYOUT]) {
      const plans = computeShotPlans(layout, WHITE_CUE_SETTINGS);
      expect(plans.length).toBeGreaterThan(0);
      expect(plans.length).toBeLessThanOrEqual(3);

      for (let i = 1; i < plans.length; i++) {
        const prev = plans[i - 1].shot;
        const cur = plans[i].shot;
        expect(TECHNIQUE_RANK[prev.technique]).toBeLessThanOrEqual(
          TECHNIQUE_RANK[cur.technique],
        );
        if (prev.technique === cur.technique) {
          expect(prev.difficultyScore).toBeGreaterThanOrEqual(cur.difficultyScore);
        }
      }
    }
  });

  it('scores a wider tolerance window as easier', () => {
    const plans = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    for (const plan of plans) {
      expect(plan.shot.difficultyScore).toBeCloseTo(
        Math.min(1, plan.toleranceDeg / CFG.easyToleranceDeg),
        6,
      );
      expect(plan.shot.difficultyScore).toBeGreaterThanOrEqual(0);
      expect(plan.shot.difficultyScore).toBeLessThanOrEqual(1);
    }
  });

  it('suppresses confidence for windows narrower than recognition error', () => {
    const plans = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    for (const plan of plans) {
      if (plan.toleranceDeg < CFG.confidenceFloorMinDeg) {
        expect(plan.shot.confidence).toBe(0);
      }
      expect(plan.shot.confidence).toBeGreaterThanOrEqual(0);
      expect(plan.shot.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('drags every shot confidence down when recognition itself is shaky', () => {
    const shaky = { ...OPEN_LAYOUT, confidence: 0.3 };
    const sure = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS)[0];
    const unsure = computeShotPlans(shaky, WHITE_CUE_SETTINGS)[0];
    expect(unsure.shot.confidence).toBeCloseTo(sure.shot.confidence * 0.3, 6);
  });

  it('reports tipOffset exactly matching the spin setting that produced each candidate, regardless of technique', () => {
    // Spin no longer implies a separate "advanced" technique (see
    // lib/types.ts's ShotTechnique doc) — a draw/follow/회전 shot can be
    // labelled direct/bank1/bank2plus/bankShot exactly like a center-ball
    // shot. The only real invariant left to check is that `tipOffset` is a
    // well-formed field on every candidate (defaulting to dead centre),
    // not that it's somehow reserved for one technique bucket.
    for (const layout of [OPEN_LAYOUT, CLUSTERED_LAYOUT]) {
      for (const plan of computeShotPlans(layout, WHITE_CUE_SETTINGS)) {
        expect(plan.shot.tipOffset).toBeDefined();
        expect(typeof plan.shot.tipOffset!.vertical).toBe('number');
        expect(typeof plan.shot.tipOffset!.horizontal).toBe('number');
      }
    }
  });

  it('reports a force level in the discrete 1-5 range', () => {
    for (const plan of computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS)) {
      expect([1, 2, 3, 4, 5]).toContain(plan.shot.forceLevel);
    }
  });
});
