# Deep Interview Spec: 키스(의도치 않은 공 충돌) 회피 로직

## Metadata
- Interview ID: kiss-avoidance-2026-08-29
- Rounds: 5
- Final Ambiguity Score: 13.25%
- Type: brownfield
- Generated: 2026-08-29
- Threshold: 0.2 (20%)
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.85 | 0.25 | 0.2125 |
| Success Criteria | 0.85 | 0.25 | 0.2125 |
| Context Clarity | 0.85 | 0.15 | 0.1275 |
| **Total Clarity** | | | **0.8675** |
| **Ambiguity** | | | **0.1325** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|--------------|---------------------------|
| 탐지 로직 (Detection) | active | 맞은 공(1적구/2적구)이 튕겨나가는 방향선이 다른 공(상대공 또는 나머지 적구)에 얼마나 가깝게 지나가는지 계산 | 아래 Goal/Technical Context에서 전부 커버 |
| 대응 정책 (Response Policy) | active | 감지된 위험도에 비례해 `Shot.confidence`를 연속적으로 감점 | 아래 Goal/Acceptance Criteria에서 전부 커버 |
| UI 노출 (UI display) | deferred | 결과 화면에 "키스 위험" 배지/표시를 보여주는 것 | 사용자가 명시적으로 다음 기회로 보류함 (Round 0) — 이번 스펙은 순수 내부 랭킹/신뢰도 로직만 다룸 |

## Goal

`lib/pathcalc/simulate.ts`의 물리 엔진은 현재 **큐볼만** 실제로 움직이는 물체로 시뮬레이션하고, 상대공·적구 2개는 스트로크 내내 "정지된 장애물"로 취급한다(모듈 docstring이 이를 "the single largest approximation"으로 명시). 그 결과, 맞은 공(1적구 또는 2적구)이 실제로는 튕겨나가면서 다른 공(상대공 또는 나머지 적구)과 부딪히는 "키스" 상황이 전혀 모델링되지 않는다.

이번 스펙의 목표: **맞은 공의 진행 방향선이 다른 공과 얼마나 가깝게 지나가는지를 근사 계산(무거운 2차 충돌 물리 시뮬레이션이 아닌 저비용 근접-거리 휴리스틱)하고, 그 근접도에 비례해 해당 샷 후보의 `confidence`를 연속적으로 감점**한다. 큐볼 자신이 다른 공(특히 상대공)과 부딪히는 경우는 이미 `opponentContactedBeforeScore`/`opponentContactedAfterScore`/`opponentContactPolicy`로 완전히 모델링되어 있으므로 이번 스펙의 범위가 아니다.

### 계산 방법 (합의된 접근)
1. `simulateShot`의 기존 충돌 루프에서 공-공 접촉(`hitBall !== null` 분기)이 발생할 때마다, 이미 계산되어 있는 `n = normalize(sub(hitBall.position, pos))`(접촉 순간의 중심선 벡터)를 맞은 공의 "진행 방향"으로 그대로 재사용한다 — 스로우(throw)를 무시한 1차 근사이며, 엔진의 기존 "first-order" 근사 철학과 일치한다.
2. 맞은 공의 위치(`hitBall.position`)를 원점, `n`을 방향으로 하는 전방(forward-only) 반직선에 대해, 그 접촉에 관여하지 않은 나머지 공들(상대공 + 아직 안 맞은 적구) 각각의 중심까지 최근접 거리를 구한다. `lib/pathcalc/geometry.ts`의 기존 `closestApproachToPoint(p, dir, maxT, c)`를 그대로 재사용할 수 있다(새 기하 함수 불필요).
3. 그 거리(`d`)를 다음 규칙으로 confidence 배수로 변환한다:
   - `d ≤ 2R`(공 지름, 즉 이 근사선이 실제로 다른 공을 관통 — 사실상 확실한 키스): 최저 배수(예: `kissMinMultiplier`, 기본값 0.1 — 0으로 완전히 죽이지 않는 이유는 "하드 필터가 아닌 소프트 감점"이라는 사용자 결정을 지키기 위함)
   - `d ≥ 2R + kissMarginMm`: 배수 1.0 (감점 없음)
   - 그 사이는 선형 보간 — 기존 `confidenceFloorDeg`/`confidenceFullDeg`의 선형 클램프 패턴과 스타일을 일치시킨다
4. 한 샷 안에서 두 번의 공-공 접촉(1적구, 2적구) 모두 위험이 있으면 각 배수를 **곱해서** 누적한다 — `techniqueFidelity`/`recognitionConfidence`가 이미 `confidence`에 곱셈으로 체이닝되는 기존 패턴(`buildShotPlan`)과 동일한 방식.

## Constraints

- 물리 모델 확장(맞은 공을 실제로 운동시켜 2차 충돌까지 시뮬레이션)은 **하지 않는다** — 근접-거리 휴리스틱만 사용한다 (Round 1에서 명시적으로 선택됨).
- 키스 위험은 **하드 필터가 아니다** — `ruleValid`/후보 생성 여부에는 전혀 영향을 주지 않는다. 오직 `confidence` 계산에만 관여한다 (Round 2에서 명시적으로 선택됨).
- 감점은 **연속적**이어야 한다 (이진 위험/안전 아님) — 가까울수록 더 크게 감점 (Round 3에서 명시적으로 선택됨).
- 새 상수 `kissMarginMm`(그레이존 폭)과 `kissMinMultiplier`(최저 배수)는 실측 없이 정성적으로 정한 엔지니어링 기본값으로 도입한다 — 이 코드베이스의 기존 관례(`THIN_CUT_MAX_THICKNESS`, `SPIN_CATEGORY_MIN_VERTICAL` 등 "Tuned qualitatively, not measured")와 동일한 방식. 제안 기본값: `kissMarginMm = 20`, `kissMinMultiplier = 0.1` — 실행 단계에서 조정 가능.
  - 주의: 기존 `recognitionErrorMm`(기본 4mm, 카메라 인식 오차용)은 의미가 달라 재사용하지 않는다 — 그레이존 폭으로 쓰기엔 너무 좁다.
- 이 기능은 `Settings`/DB 스키마를 건드리지 않는다 (사용자 설정 항목이 아님, 항상 활성화된 내부 랭킹 로직).

## Non-Goals

- 결과 화면(ShotDiagram)에 "키스 위험" 배지나 별도 표시를 추가하는 것 (UI 노출 컴포넌트는 명시적으로 보류됨)
- 맞은 공의 실제 2차 충돌 궤적을 정밀 물리로 시뮬레이션하는 것 (다음 버전 후보로 남김)
- 키스 위험이 있는 후보를 추천 목록에서 완전히 제외하는 하드 필터
- 다음 실전 play-gate 테스트에 "키스 발생 여부" 기록 칸을 추가하는 것 (유닛테스트만으로 충분하다고 확정)
- 상대공이 아닌 두 적구 사이의 "의도적인" 연속 접촉(예: 얼어붙은 두 공을 연쇄로 맞히는 정상적인 샷)을 위험으로 오분류하는 것을 막는 별도 예외 처리 — 이번 스펙에서는 다루지 않으며, 실전 테스트에서 오탐이 확인되면 후속 조정

## Acceptance Criteria

- [ ] `simulateShot`은 공-공 접촉이 발생할 때마다, 맞은 공의 진행 방향선(`n`)이 그 접촉에 관여하지 않은 나머지 공들 각각에 얼마나 가깝게 지나가는지 계산한다 (`closestApproachToPoint` 재사용)
- [ ] 거리가 `2 × BALL_RADIUS_MM` 이하면 confidence 배수가 `kissMinMultiplier`(기본 0.1)로, `2 × BALL_RADIUS_MM + kissMarginMm` 이상이면 1.0으로, 그 사이는 선형 보간된 값이 적용된다
- [ ] 한 샷에서 여러 접촉에 위험이 있으면 배수가 곱셈으로 누적된다
- [ ] 키스 위험 감점은 `ruleValid`/`foul`/후보 필터링에는 전혀 영향을 주지 않는다 — 오직 `Shot.confidence`만 변경한다
- [ ] 다른 공이 근처에 없는 기존 레이아웃들의 confidence/랭킹은 이 변경 전후로 동일하다 (회귀 없음) — 기존 183개 테스트가 그대로 통과해야 함
- [ ] 신규 유닛 테스트: 맞은 공의 진행선상에 다른 공을 가깝게 배치한 고정 픽스처(`lib/pathcalc/fixtures.ts`에 추가)에서, 그 공이 없는 동일 배치보다 confidence가 유의미하게 낮게 나오는 것을 검증
- [ ] 신규 유닛 테스트: 진행선이 다른 공에서 충분히 먼 경우 confidence가 감점 없이 그대로 나오는 것을 검증 (그레이존 밖 회귀 확인)
- [ ] `tsc --noEmit`, `npm run lint`, `npm test`(기존+신규 전부), `npm run build` 모두 클린

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "키스"는 큐볼이 다른 공을 잘못 건드리는 것을 뜻할 것이다 | 코드 확인 결과 그 상황은 이미 `opponentContactedBeforeScore`/`AfterScore`로 완전히 모델링되어 있음을 제시 | 사용자가 "맞은 공이 다른 공을 건드리는 것"으로 범위를 명확히 확정 — 기존에 다루지 않는 진짜 gap |
| 정확한 회피를 위해선 맞은 공을 실제로 물리 시뮬레이션해야 할 것이다 | 정밀 물리(A) vs 근접거리 휴리스틱(B)의 비용/정확도 트레이드오프를 제시 | 사용자가 근접거리 휴리스틱(B) 선택 — 기존 `n` 벡터·`closestApproachToPoint`를 재사용해 사실상 추가 계산 비용이 거의 없음이 확인됨 |
| 위험 감지 시 후보를 아예 숨겨야(필터) 할 것이다 | 하드 필터 vs confidence 감점 vs 이진+거리비례 혼합 3가지 옵션 제시 | 사용자가 confidence 감점만 선택 — 기존 `techniqueFidelity` 곱셈 감점과 동일한 아키텍처 패턴으로 통일 |
| 감점은 위험/안전 이진 판정이면 충분할 것이다 | 기존 confidence 계산이 이미 연속적(각도 허용범위 기반)임을 제시 | 사용자가 거리 비례 연속 감점 선택 — 기존 스타일과 일관성 유지 |
| 검증을 위해 실전 play-gate 테스트에도 반영이 필요할 것이다 | 유닛테스트만 vs 유닛테스트+실전 기록 병행 두 옵션 제시 | 사용자가 유닛테스트만으로 충분하다고 확정 |

## Technical Context

- **파일**: `lib/pathcalc/simulate.ts` — `simulateShot()` 함수 내 `for (let iter...)` 루프의 `if (hitBall !== null) { ... }` 분기. 이미 `n = normalize(sub(hitBall.position, pos))`가 계산되어 있어 그대로 재사용 가능.
- **재사용 가능한 기존 유틸**: `lib/pathcalc/geometry.ts`의 `closestApproachToPoint(p, dir, maxT, c)` — 이미 `missDistanceMm` 계산에 쓰이고 있는 것과 동일한 함수. 새 기하 계산 코드가 사실상 필요 없음.
- **컨피던스 체이닝 패턴**: `lib/pathcalc/candidates.ts`의 `buildShotPlan`/`buildFallbackPlan`에서 `confidence *= cfg.techniqueFidelity[technique]; confidence *= clamp01(recognitionConfidence);` 형태로 이미 곱셈 체이닝 중 — 새 `kissRiskMultiplier`도 동일한 자리에 같은 방식으로 추가.
- **설정값 추가 위치**: `lib/pathcalc/config.ts`의 `PathCalcConfig`에 `kissMarginMm`, `kissMinMultiplier` 추가 (`DEFAULT_PATHCALC_CONFIG`에 기본값 세팅) — `THIN_CUT_MAX_THICKNESS` 등 기존 정성적 튜닝 상수들과 같은 위치/스타일.
- **결과 전달**: `SimulationResult`에 `kissRiskMultiplier: number`(기본 1) 필드를 추가해 두면, 지금은 UI에 노출하지 않더라도 나중에 "키스 위험" 배지를 붙일 때 바로 재사용 가능 (Non-Goal이지만 미래 확장을 막지 않는 설계).
- **테스트 위치**: `lib/pathcalc/fixtures.ts`에 새 레이아웃 추가 (예: `KISS_RISK_LAYOUT` — 적구를 맞춘 직후 진행선상에 상대공이 가깝게 놓인 배치), `lib/pathcalc/physics.test.ts` 또는 `rules.test.ts`에 검증 테스트 추가.

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|----------------|
| KissRisk (신규, 계산값) | Core domain (physics) | strikingBallId, otherBallId, clearanceMm, confidenceMultiplier | computedAt(ContactEvent) 시점마다, appliesTo(SimulationResult.kissRiskMultiplier → Shot.confidence) |
| ContactEvent (기존) | Core domain | kind, ballId, at, distanceMm, thickness | KissRisk 계산의 입력(이미 계산된 `n`, `hitBall.position` 재사용) |
| SimulationResult (기존, 확장) | Core domain | + `kissRiskMultiplier: number` | 여러 ContactEvent의 KissRisk 배수를 곱해서 누적 |
| Shot.confidence (기존, 확장) | Core domain | 계산식에 `kissRiskMultiplier` 곱셈 항 추가 | consumedBy(ShotDiagram의 저신뢰도 배지 — 로직은 그대로, 입력값만 달라짐) |

## Ontology Convergence

| Round | 핵심 개념 | 비고 |
|-------|-----------|------|
| 1 | "맞은 공", "다른 공" | 범위를 큐볼-공 충돌(이미 모델링됨)과 공-공 2차 충돌(미모델링, 진짜 gap)로 분리 |
| 2 | StruckBall 진행방향(`n` 재사용), 근접거리 휴리스틱 | 정밀 물리 옵션 기각, 기존 벡터 재사용으로 수렴 |
| 3 | ConfidencePenalty(대응 정책) | 하드 필터 기각, confidence 감점으로 수렴 |
| 4 | 연속 스케일링 | 이진 위험/안전 기각, 기존 `confidenceFloorDeg` 스타일 선형 보간으로 수렴 |
| 5 | 검증 방식(유닛테스트) | 실전 테스트 병행 기각, 유닛테스트만으로 확정 |

라운드가 진행될수록 핵심 엔티티(KissRisk, ConfidencePenalty)가 계속 재사용/구체화되었고 매 라운드 기각된 대안(정밀 물리, 하드 필터, 이진 판정, 실전 테스트 병행)이 모두 "더 무겁거나 기존 스타일과 어긋나는" 쪽이었다는 점에서 방향이 일관되게 수렴함.

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds + Round 0 topology)</summary>

### Round 0 — Topology
**Q:** 탐지 로직 / 대응 정책 / UI 노출 3개 컴포넌트로 나눠도 되는지?
**A:** 탐지+대응만 진행, UI는 보류.

### Round 1
**Q:** "키스"로 막고 싶은 상황이 구체적으로 무엇인가 — 큐볼이 다른 공을 스치는 것(이미 모델링됨) vs 맞은 공이 다른 공을 건드리는 것(미모델링) vs 둘 다?
**A:** 맞은 공이 다른 공을 건드리는 것.
**Ambiguity:** 59% (Goal: 0.55, Constraints: 0.2, Criteria: 0.2, Context: 0.8)

### Round 2
**Q:** 감지 정밀도 — (A) 정밀 물리 시뮬레이션 vs (B) 근접거리 휴리스틱?
**A:** (B) 근접거리 휴리스틱.
**Ambiguity:** 43.5% (Goal: 0.75, Constraints: 0.5, Criteria: 0.2, Context: 0.85)

### Round 3
**Q:** 키스 위험 감지 시 후보를 어떻게 처리할까 — 하드 필터 vs confidence 감점 vs 거리 기반 혼합?
**A:** confidence 감점.
**Ambiguity:** 30.5% (Goal: 0.8, Constraints: 0.65, Criteria: 0.5, Context: 0.85)

### Round 4
**Q:** confidence 감점을 거리에 비례해 연속적으로 줄지, 고정 감점(이진)으로 줄지?
**A:** 거리에 비례해 연속적으로.
**Ambiguity:** 20.75% (Goal: 0.9, Constraints: 0.8, Criteria: 0.6, Context: 0.85)

### Round 5
**Q:** 이 기능을 어떻게 검증할까 — 유닛테스트만 vs 유닛테스트+다음 실전 테스트 기록?
**A:** 유닛테스트만으로 충분.
**Ambiguity:** 13.25% (Goal: 0.9, Constraints: 0.85, Criteria: 0.85, Context: 0.85) — **임계값(20%) 이하 도달**

</details>
