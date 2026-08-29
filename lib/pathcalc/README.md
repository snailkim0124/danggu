# lib/pathcalc

Path Calculation engine — enumerates candidate carom shots and ranks them, in pure TypeScript (no native dependencies, so it runs fine in Vercel serverless).

Implements PRD "캐롬 경로 계산(Path Calculation)" / plan Phase 2. Entry point: `computeShotPlans(recognition, settings?, config?)` (full output incl. route polylines) or `computeShots(...)` / `computePathCalcResult(...)` for narrower views.

## Files

| File | Role |
|------|------|
| `config.ts` | Every tuning constant and physical coefficient in one place (`PathCalcConfig`) |
| `geometry.ts` | 2D vector / ray-casting primitives over the shared `Point` type |
| `table.ts` | mm-space table bounds and cushion intersection |
| `simulate.ts` | Cue-ball stroke simulator + the 4구 rule model |
| `candidates.ts` | Aim sweep, tolerance refinement, difficulty/confidence scoring, ranking |
| `index.ts` | Public API and role resolution |
| `fixtures.ts` | Hand-built `RecognitionResult` layouts for tests and development |

## The 4구(사구) rule model

A stroke **scores** when the cue ball contacts **both** red object balls in one stroke, in either order, directly or via any number of cushions. 4구 has no minimum-cushion requirement.

A stroke **fouls** — and is hard-filtered out (`ruleValid: false`, excluded from results, never merely down-ranked) — when the cue ball touches the **opponent ball**:

- before both reds are contacted → always a foul;
- after the score → a foul only while the cue ball is still rolling out (`postScoreRolloutTableLengths`, default half a table length). Past that the player can simply stroke softer, so treating it as a foul would reject legitimate shots. Set `opponentContactPolicy: 'strict'` for house rules where any contact loses the turn.

Path occlusion needs no separate check: the simulator hits whatever is actually in the way first, so a blocked line resolves to a contact with the blocker.

**Not modelled:** cue ball leaving the table, double hits / push shots on frozen balls, miscues. None are predictable from single-photo 2D geometry, so the engine is optimistic on frozen-ball layouts.

## Physical approximations

**Ball-ball contact.** Outgoing cue-ball velocity is `v = (5/7)·sinθ·T + s·d`, where `θ` is the cut angle, `T` the tangent line and `d` the incoming direction. This reproduces the 90° rule (`s = 0`) and the 30° rule (`s = 2/7`, giving 33.7° at θ=30° and 29.0° at θ=45°) exactly.

**Spin.** `s` evolves with distance rather than being fixed per stroke:

```
s(d) = 2/7 + (s₀ - 2/7)·exp(-d / slidingLengthMm)
```

with `s₀ = (5/14)·tipOffset.vertical`. A centre-ball hit imparts *no* spin (`s₀ = 0`), so it behaves like a stun shot up close and follows the 30° rule at range — and draw correctly dies out with distance. `d` resets at every collision. Object balls are treated as stationary obstacles for the whole stroke, which is sound for 4구 scoring because only the cue ball's contacts matter.

**Cushions.** First-order mirror reflection. Speed-dependent angle shortening and cushion "throw" are **not** modelled — neither is observable from a single photo. Side spin adds a tangential velocity in the `ẑ × n` direction, which is what makes 회전 bank routes distinguishable.

**Energy.** `remainingMm` is the distance the cue ball can still roll; under constant rolling deceleration that scales as `v²`, so a collision multiplying speed by `m` multiplies it by `m²`. `ForceLevel` comes from the effort accumulated *up to the score*, not the rollout after it.

Fidelity is deliberately first-order; the plan's Risk R3 and Open Follow-up "고급기술샷 스핀 시뮬레이션 정밀도는 Phase 5 실측 이후 튜닝" both anticipate retuning `config.ts` against real measurements.

## Candidate enumeration and scoring

The engine sweeps the full 360° of aim angle for each of 11 spin settings and simulates every sample, then classifies the technique *from the result*. Each maximal contiguous run of scoring angles is one candidate, and the run's width **is** the angular tolerance — refined by bisection so it is not quantised to the sweep step. Because ball radii are in the simulator, that window is a real tolerance, not a zero-width ray.

- `difficultyScore = min(1, toleranceDeg / easyToleranceDeg)` — higher is easier, per the `Shot` contract.
- `confidence` ramps from a recognition-derived floor (`√2·ε/L`, clamped) to `confidenceFullDeg`, then is multiplied by a per-technique fidelity discount and by `RecognitionResult.confidence`.
- Ranked by technique (`direct < bank1 < bank2plus < advanced`) then by descending `difficultyScore`, de-duplicated by aim angle, capped at `topN` (3).
- When no rule-valid candidate exists, a single closest-miss shot is returned with `ruleValid: false` and low confidence, per plan "유효 후보 0개 시 근접 샷 fallback".

Consumes/produces the shared types in `lib/types.ts` (`Ball`, `TableGeometry`, `Shot`). Do not redefine those shapes here. `ShotPlan` (in `candidates.ts`) additively carries the route polyline the shared `Shot` type has no field for.
