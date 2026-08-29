/**
 * Cue-ball stroke simulator and the 4구(사구) rule model.
 *
 * ## What is simulated
 *
 * Only the **cue ball** is tracked. It is fired from its recognised position
 * along an aim direction, and its path is traced through ball contacts and
 * cushion rebounds until it runs out of roll. Object balls are treated as
 * stationary obstacles for the whole stroke — this is the single largest
 * approximation in the engine, and it is sound for 4구 scoring because scoring
 * depends solely on which balls the *cue ball* touches. It is unsound only when
 * a struck red ball would travel back into the cue ball's later path, which is
 * rare and always makes the engine optimistic rather than reckless.
 *
 * ## Ball-ball contact model (90° / 30° rule)
 *
 * At contact, let `n` be the unit line of centres and `θ` the cut angle between
 * the incoming direction `d` and `n`. The outgoing cue-ball velocity is
 *
 *     v = tangentGain · sinθ · T  +  s · d
 *
 * where `T` is the unit tangent (perpendicular to `n`, on the `d` side) and `s`
 * is the residual velocity along the original line contributed by vertical
 * spin. With `tangentGain = 5/7` and `s = 2/7` (a naturally rolling cue ball)
 * this reproduces the textbook results exactly:
 *
 *   - `s = 0`  → the cue ball leaves along the tangent line (**90° rule**)
 *   - `s = 2/7` → ~30° deflection across the quarter-to-three-quarter hit range
 *     (**30° rule**; θ=30° gives 33.7°, θ=45° gives 29.0°)
 *   - θ = 0 with `s = 0` → `v = 0`, the cue ball stops dead (stun)
 *   - θ = 0 with `s < 0` → the cue ball returns along `-d` (draw)
 *
 * `s` is not a constant of the stroke — it **evolves as the cue ball travels**.
 * A centre-ball hit imparts no spin whatsoever, so the ball leaves the tip
 * sliding (`s = 0`, pure stun behaviour) and friction spins it up toward
 * natural roll (`s = 2/7`) over `slidingLengthMm`:
 *
 *     s(d) = 2/7 + (s₀ - 2/7) · exp(-d / slidingLengthMm)
 *
 * with `s₀ = spinToVelocity · tipOffset.vertical` (see
 * {@link initialSpinVelocity}). This is what reproduces real table behaviour:
 * a centre-ball hit cuts sharply up close and follows the 30° rule at range,
 * and draw dies out with distance. `d` resets at every collision, since a
 * collision leaves the ball sliding again.
 *
 * ## Cushion model
 *
 * First-order mirror reflection (angle of incidence = angle of reflection).
 * Speed-dependent angle shortening and cushion "throw" are **not** modelled —
 * neither is observable from a single photo. Side spin adds a tangential
 * velocity at the cushion in the `ẑ × n` direction, which is what makes
 * 회전 (english) bank routes distinguishable from plain ones.
 *
 * ## Energy model
 *
 * `remainingMm` is the distance the cue ball can still roll. Under constant
 * rolling deceleration that distance is proportional to v², so multiplying the
 * speed by `m` at a collision multiplies the remaining distance by `m²`.
 * `effortMm` accumulates each segment normalised back to initial-speed
 * equivalent (`len / speedFactor²`), giving the roll distance the stroke would
 * need on an empty table — which is what `ForceLevel` is derived from.
 */

import type { Ball, Point } from '@/lib/types';
import {
  add,
  clamp,
  closestApproachToPoint,
  distance,
  dot,
  fromAngleRad,
  lengthOf,
  normalize,
  rayCircleHit,
  scale,
  sub,
} from './geometry';
import type { PathCalcConfig, TipOffset } from './config';
import { nextCushionHit, type CushionId, type TableBounds } from './table';

/** Balls and table for one stroke, with roles already resolved. */
export interface ShotSetup {
  cueBall: Ball;
  opponentBall: Ball;
  redBalls: [Ball, Ball];
  bounds: TableBounds;
}

export interface ContactEvent {
  kind: 'ball' | 'cushion';
  /** Set when `kind === 'ball'`. */
  ballId?: string;
  /** Set when `kind === 'cushion'`. */
  cushion?: CushionId;
  /** Cue-ball centre at the moment of contact. */
  at: Point;
  /** Cumulative path length travelled when the contact happened. */
  distanceMm: number;
  /** Hit fullness for ball contacts: 1 = dead full, 0 = edge. */
  thickness?: number;
}

export interface SimulationResult {
  events: ContactEvent[];
  /** Cue-ball centre polyline, ready for the Phase 3 diagram renderer. */
  path: Point[];
  totalDistanceMm: number;
  /** Roll distance the same stroke would need on an empty table. */
  effortMm: number;
  /** `effortMm` at the moment the second red was contacted — the stroke
   * strength the shot actually requires, which is what `ForceLevel` is derived
   * from. `-1` when the shot never scored. */
  effortAtScoreMm: number;
  /** Red ball ids in the order the cue ball touched them (deduplicated). */
  redsContacted: string[];
  /** Both reds touched — the D2 scoring condition, before foul checks. */
  scored: boolean;
  opponentContactedBeforeScore: boolean;
  opponentContactedAfterScore: boolean;
  /** Rollout distance past the score at which the opponent ball was touched. */
  opponentContactDistanceAfterScore: number;
  /** Foul per the configured {@link PathCalcConfig.opponentContactPolicy}. */
  foul: boolean;
  /** `scored && !foul` — the hard rule filter behind `Shot.ruleValid`. */
  ruleValid: boolean;
  cushionsTotal: number;
  /** Cushions taken before the second red was contacted; -1 if never scored. */
  cushionsBeforeScore: number;
  cushionsAtFirstBallContact: number;
  /** Fullness of the first ball contact, or null if nothing was hit. */
  firstThickness: number | null;
  /** Distance to the first ball contact, or null if nothing was hit. */
  firstContactDistanceMm: number | null;
  /**
   * How badly the shot missed: summed over reds that were never contacted, the
   * closest the cue-ball centre ever came to that red, minus the 2R contact
   * distance. `0` for a scoring shot. Drives the near-miss fallback.
   */
  missDistanceMm: number;
}

/**
 * Post-contact velocity along the original line imparted by the cue tip, before
 * any sliding-to-rolling conversion.
 *
 *   `v =  0` → `0`      — centre ball: no spin at all, pure stun (90° rule)
 *   `v = -1` → `-5/14`  — maximum draw / 끌어치기
 *   `v = +1` → `+5/14`  — maximum follow / 밀어치기
 */
export function initialSpinVelocity(vertical: number, cfg: PathCalcConfig): number {
  return cfg.spinToVelocity * vertical;
}

/** Spin velocity after sliding `distanceMm` since the last collision. */
export function spinVelocityAfter(
  initial: number,
  distanceMm: number,
  cfg: PathCalcConfig,
): number {
  const nr = cfg.naturalRollSpin;
  return nr + (initial - nr) * Math.exp(-distanceMm / cfg.slidingLengthMm);
}

/** Mirror reflection off a cushion, plus the tangential kick from side spin. */
export function reflectOffCushion(
  dir: Point,
  inwardNormal: Point,
  sideSpin: number,
  cfg: PathCalcConfig,
): Point {
  const mirror = sub(dir, scale(inwardNormal, 2 * dot(dir, inwardNormal)));
  if (Math.abs(sideSpin) < 1e-6) return normalize(mirror);
  // ẑ × n for the inward normal n: friction at the cushion converts side spin
  // into tangential velocity in this direction.
  const tangent: Point = { x: -inwardNormal.y, y: inwardNormal.x };
  return normalize(add(mirror, scale(tangent, cfg.cushionSpinGain * sideSpin)));
}

/**
 * Trace one stroke and evaluate it against the 4구 rule model.
 *
 * @param aimRad Initial aim direction, radians CCW from +x in table mm space.
 */
export function simulateShot(
  setup: ShotSetup,
  aimRad: number,
  tip: TipOffset,
  cfg: PathCalcConfig,
): SimulationResult {
  const contactDist = 2 * cfg.ballRadiusMm;
  const others: Ball[] = [setup.opponentBall, setup.redBalls[0], setup.redBalls[1]];
  const redIds = new Set([setup.redBalls[0].id, setup.redBalls[1].id]);

  const rolloutMm = cfg.postScoreRolloutTableLengths * setup.bounds.longSideMm;

  let pos: Point = { ...setup.cueBall.position };
  let dir = fromAngleRad(aimRad);
  let speedFactor = 1;
  let remainingMm = cfg.maxTravelTableLengths * setup.bounds.longSideMm;
  let sideSpin = tip.horizontal;
  let spinAtLastEvent = initialSpinVelocity(tip.vertical, cfg);
  let distanceSinceLastEvent = 0;

  const events: ContactEvent[] = [];
  const path: Point[] = [{ ...pos }];
  const closest = new Map<string, number>();
  for (const b of others) closest.set(b.id, distance(pos, b.position));

  const redsContacted: string[] = [];
  let opponentContactedBeforeScore = false;
  let opponentContactedAfterScore = false;
  let opponentContactDistanceAfterScore = Infinity;
  let cushionsTotal = 0;
  let cushionsBeforeScore = -1;
  let cushionsAtFirstBallContact = 0;
  let firstThickness: number | null = null;
  let firstContactDistanceMm: number | null = null;
  let firstContactDone = false;
  let justContactedId: string | null = null;
  let scoreDistanceMm = -1;
  let travelled = 0;
  let effortMm = 0;
  let effortAtScoreMm = -1;

  for (let iter = 0; iter < cfg.maxEvents && remainingMm > cfg.minSegmentMm; iter++) {
    // A just-contacted ball becomes eligible again once the cue ball has
    // physically separated from it; without this the same contact re-fires at
    // t≈0 forever.
    if (justContactedId !== null) {
      const prev = others.find((b) => b.id === justContactedId);
      if (prev && distance(pos, prev.position) > contactDist + cfg.contactSlackMm) {
        justContactedId = null;
      }
    }

    const cushion = nextCushionHit(pos, dir, setup.bounds, cfg.ballRadiusMm);
    let bestT = cushion.t;
    let hitBall: Ball | null = null;

    for (const b of others) {
      if (b.id === justContactedId) continue;
      let t: number | null;
      if (distance(pos, b.position) <= contactDist + cfg.contactSlackMm) {
        // Frozen / touching: a contact only if we are actually driving into it.
        t = dot(normalize(sub(b.position, pos)), dir) > 0 ? 0 : null;
      } else {
        t = rayCircleHit(pos, dir, b.position, contactDist, 0);
      }
      if (t !== null && t < bestT) {
        bestT = t;
        hitBall = b;
      }
    }

    const segLen = Math.min(bestT, remainingMm);

    // Track how near the cue ball ever came to each red, for the miss metric.
    for (const b of others) {
      const d = closestApproachToPoint(pos, dir, segLen, b.position);
      const prev = closest.get(b.id);
      if (prev === undefined || d < prev) closest.set(b.id, d);
    }

    pos = add(pos, scale(dir, segLen));
    travelled += segLen;
    distanceSinceLastEvent += segLen;
    effortMm += segLen / (speedFactor * speedFactor);
    remainingMm -= segLen;
    path.push({ ...pos });

    // Ran out of roll before reaching the next event.
    if (segLen + cfg.minSegmentMm < bestT) break;

    // Once the score is in and the cue ball has rolled clear of the window in
    // which the player could not have stopped it, nothing further can change
    // the verdict — stop rather than tracing a rollout that will never be played.
    if (
      cfg.opponentContactPolicy === 'before-score' &&
      scoreDistanceMm >= 0 &&
      travelled - scoreDistanceMm > rolloutMm
    ) {
      break;
    }

    if (hitBall !== null) {
      const n = normalize(sub(hitBall.position, pos));
      const cosT = clamp(dot(dir, n), -1, 1);
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      // Perpendicular offset between the cue ball's line and the object centre
      // is 2R·sinθ; expressing it as a fraction of 2R gives the 당구 두께
      // convention (a half-ball hit puts the cue ball's edge on the object
      // ball's centre → sinθ = 0.5 → thickness 0.5).
      const thickness = clamp(1 - sinT, 0, 1);

      events.push({
        kind: 'ball',
        ballId: hitBall.id,
        at: { ...pos },
        distanceMm: travelled,
        thickness,
      });

      if (!firstContactDone) {
        firstThickness = thickness;
        firstContactDistanceMm = travelled;
        cushionsAtFirstBallContact = cushionsTotal;
      }

      const alreadyScored = redsContacted.length >= 2;
      if (redIds.has(hitBall.id)) {
        if (!redsContacted.includes(hitBall.id)) {
          redsContacted.push(hitBall.id);
          if (redsContacted.length === 2) {
            cushionsBeforeScore = cushionsTotal;
            scoreDistanceMm = travelled;
            effortAtScoreMm = effortMm;
          }
        }
      } else if (alreadyScored) {
        opponentContactedAfterScore = true;
        opponentContactDistanceAfterScore = Math.min(
          opponentContactDistanceAfterScore,
          travelled - scoreDistanceMm,
        );
      } else {
        opponentContactedBeforeScore = true;
      }

      const s = spinVelocityAfter(spinAtLastEvent, distanceSinceLastEvent, cfg);
      const tangential = sub(dir, scale(n, cosT)); // magnitude sinθ, along T
      const outgoing = add(scale(tangential, cfg.tangentGain), scale(dir, s));
      const speed = lengthOf(outgoing);
      firstContactDone = true;
      justContactedId = hitBall.id;
      // A collision leaves the cue ball sliding again, so the spin-up restarts.
      spinAtLastEvent = 0;
      distanceSinceLastEvent = 0;

      if (speed < cfg.minSpeed) break; // cue ball stops dead
      dir = scale(outgoing, 1 / speed);
      const m = Math.min(1, speed);
      speedFactor *= m;
      remainingMm *= m * m;
    } else {
      cushionsTotal += 1;
      events.push({
        kind: 'cushion',
        cushion: cushion.cushion,
        at: { ...pos },
        distanceMm: travelled,
      });
      dir = reflectOffCushion(dir, cushion.normal, sideSpin, cfg);
      sideSpin *= cfg.sideSpinDecayPerCushion;
      spinAtLastEvent = 0;
      distanceSinceLastEvent = 0;
      speedFactor *= cfg.cushionSpeedRetention;
      remainingMm *= cfg.cushionSpeedRetention * cfg.cushionSpeedRetention;
    }
  }

  const scored = redsContacted.length === 2;
  const foul =
    opponentContactedBeforeScore ||
    (opponentContactedAfterScore &&
      (cfg.opponentContactPolicy === 'strict' ||
        opponentContactDistanceAfterScore <= rolloutMm));

  let missDistanceMm = 0;
  for (const red of setup.redBalls) {
    if (redsContacted.includes(red.id)) continue;
    const nearest = closest.get(red.id) ?? Infinity;
    missDistanceMm += Math.max(0, nearest - contactDist);
  }

  return {
    events,
    path,
    totalDistanceMm: travelled,
    effortMm,
    effortAtScoreMm,
    redsContacted,
    scored,
    opponentContactedBeforeScore,
    opponentContactedAfterScore,
    opponentContactDistanceAfterScore,
    foul,
    ruleValid: scored && !foul,
    cushionsTotal,
    cushionsBeforeScore,
    cushionsAtFirstBallContact,
    firstThickness,
    firstContactDistanceMm,
    missDistanceMm,
  };
}

/**
 * Ordering key for the near-miss fallback: smaller is closer to succeeding.
 * A foul is charged a large synthetic miss distance so that any legal near-miss
 * is always preferred over any foul route.
 */
export function nearMissPenalty(sim: SimulationResult, cfg: PathCalcConfig): number {
  return sim.missDistanceMm + (sim.foul ? cfg.foulPenaltyMm : 0);
}
