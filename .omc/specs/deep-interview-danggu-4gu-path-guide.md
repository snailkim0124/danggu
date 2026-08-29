# Deep Interview Spec: 4구(사구) 당구 샷 경로 자동 안내 서비스

## Metadata
- Interview ID: di-danggu-4gu-001
- Rounds: 18
- Final Ambiguity Score: 14%
- Type: Greenfield
- Generated: 2026-08-28
- Threshold: 0.2 (20%)
- Threshold Source: default
- Initial Context Summarized: No
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.875 | 40% | 0.350 |
| Constraint Clarity | 0.85 | 30% | 0.255 |
| Success Criteria | 0.8625 | 30% | 0.259 |
| **Total Clarity** | | | **0.864** |
| **Ambiguity** | | | **0.136 (~14%)** |

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|---------------------------|
| Capture | Active | 사진 촬영/업로드 입구 | 단일 정지 사진 1장 업로드, 웹(모바일 브라우저 카메라) MVP로 확정 |
| Vision Recognition | Active | 사진에서 테이블 경계와 공 4개(흰공1, 노랑공1, 빨간공2) 위치 인식 | 사람 시점(비스듬한 각도) 사진 지원, 테이블 경계 완전 자동 AI 감지, 인식 불확실 시 사용자 터치 보정 fallback |
| Path Calculation | Active | 4구 규칙 기반 진행 가능 경로(캐롬 루트) 계산 | 직접샷/뱅킹/고급기술 전 범위 계산 → 기술종류 우선순위 기준 최적(가장 쉬운) 샷 대표 제시, 각도+힘 수치까지 실전 정밀도로 산출 |
| Result Visualization | Active | 계산된 경로를 사용자에게 표시 | 사진이 아닌 정적 2D 다이어그램으로 재구성, 여러 샷 후보 탭/스와이프 전환 가능 |
| User Skill Profile (Personalization) | **Deferred** | 사용자 설문 기반 개인 난이도 기준 | 사유: MVP는 고정 기술종류 난이도 기준 사용, 개인화 설문은 차기 버전으로 보류 (Round 9 확정) |

## Goal
사용자가 모바일 브라우저에서 당구대 사진을 한 장 찍어 업로드하면, 시스템이 테이블과 공(흰공/노랑공/빨간공 2개) 위치를 완전 자동으로 인식하고, 4구 규칙에 맞는 모든 가능한 캐롬 경로(직접샷, 뱅킹샷, 고급 기술샷 포함)를 계산한 뒤, 기술 종류 우선순위 기준으로 가장 치기 쉬운 샷을 대표로 선정하여 — 실전에서 바로 따라칠 수 있는 수준의 각도·힘 수치와 함께 — 정적 2D 다이어그램으로 보여주는 웹 서비스를 만든다. 사용자는 대표 샷 외 다른 기술 후보도 전환하며 볼 수 있다.

## Constraints
- 플랫폼: 웹(모바일 브라우저) MVP만. 네이티브 앱은 향후 확장
- 촬영 방식: 단일 정지 사진 1장 (실시간 영상/AR 라이브 뷰 아님)
- 촬영 각도: 사람이 실제 치는 시점의 비스듬한 사진 지원 (탑뷰 강제 아님) → 원근보정(캘리브레이션) 필수
- 테이블 경계 및 공 위치 인식은 완전 자동(AI) — 사용자 개입 없는 것이 기본 플로우
- 인식이 불확실/실패할 경우에만 사용자가 터치로 공 위치를 수동 보정하는 fallback 제공
- 큐볼(내 공)이 흰공인지 노랑공인지는 매번 묻지 않고 설정에서 미리 지정해 재사용
- 샷 난이도 판정 기준(v1): 기술 종류 자체의 위계 (직접샷 < 1쿠션 이상 뱅킹 < 고급기술), 개인화 없음
- 경로 계산 정밀도: "참고용 근사치"가 아니라 실전에서 바로 따라칠 수 있는 수준(각도/힘 수치 포함)이어야 함
- 결과 표시는 원본 사진 오버레이가 아니라 재구성된 정적 다이어그램
- 샷 후보는 난이도 순 상위 3개까지만 표시
- 유효한(성공 가능한) 캐롬 경로가 하나도 없는 극단적 배치에서는, 가장 근접한(거의 성공할 법한) 샷을 참고용으로 대신 제시

## Non-Goals
- 실시간 카메라/AR 라이브 오버레이 (v1 범위 아님)
- 점수 기록, 경기 이력 관리, 멀티플레이어 대전 모드
- 사용자 설문 기반 개인화 난이도 기준 (v2 이후로 보류)
- 100% 오차 없는 인식 보장 (수동 보정 fallback으로 오차 대응, 완전 무결점을 목표로 하지 않음)

## Acceptance Criteria
- [ ] 사용자가 모바일 브라우저에서 당구대 사진 1장을 업로드하면, 시스템이 테이블 경계와 공 4개(흰공/노랑공/빨간공×2) 위치를 자동으로 인식한다
- [ ] 인식이 불확실한 경우 사용자가 터치로 공 위치를 수동 보정할 수 있다
- [ ] 시스템은 설정에 저장된 사용자의 큐볼 색상(흰공/노랑공)을 기준으로 경로를 계산한다
- [ ] 시스템은 직접샷, 1쿠션 이상 뱅킹샷, 고급 기술샷을 포함한 모든 가능한 캐롬 경로를 계산하고, 기술 종류 우선순위(직접 < 뱅킹 < 고급기술) 기준으로 가장 쉬운 샷을 대표로 제시한다
- [ ] 추천된 샷은 각도(도)와 힘(강도) 수치를 포함해 실전에서 바로 따라칠 수 있는 수준으로 제공된다
- [ ] 결과는 사진이 아닌 정적 2D 다이어그램으로 재구성되어 표시되며, 사용자는 여러 샷 후보를 탭/스와이프로 전환해 볼 수 있다
- [ ] 점수 기록, 경기 이력, 멀티플레이어 기능은 이번 버전에 포함되지 않는다
- [ ] 개인화 난이도 설문 기능은 이번 버전에 포함되지 않으며, 고정된 기술종류 기준이 사용된다
- [ ] MVP 완성 판정: 서로 다른 실제 테이블 배치 10건을 테스트하여, 추천된 샷대로 직접 쳤을 때 7건(70%) 이상 실제로 맞으면 성공으로 간주한다
- [ ] 샷 후보가 여러 개일 경우 난이도 순으로 상위 3개까지만 표시한다
- [ ] 유효한 캐롬 경로가 하나도 없는 배치에서는 가장 근접한(거의 성공할 법한) 샷을 참고용으로 제시한다

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 4구는 흰공 2개+빨간공 2개일 것 | Round 0에서 사용자가 직접 정정 | 흰공1 + 노랑공1 + 빨간공2 |
| 대략적인 방향만 알려줘도 충분할 것 | Round 4 Contrarian: "오차가 있는 참고용 가이드라면 어느 정도까지 맞아야 성공인가?" | 실전에서 바로 따라칠 수 있는 정밀도(각도/힘 수치 포함) 필요 |
| 사진은 탑뷰로 찍을 것 | Round 2: 촬영 조건 확인 | 사람 시점의 비스듬한 사진 지원, 원근보정 필수 |
| 캘리브레이션은 사용자가 모서리를 탭하면 충분할 것 | Round 6 Simplifier: "완전 자동 vs 사용자 보조" | 완전 자동 AI 감지가 필요(원 요청 "자동으로"와 부합), occlusion 시에만 수동 보정 |
| 난이도는 시스템이 정하는 고정 규칙일 것 | Round 8 Ontologist에서 사용자가 "설문 기반 개인화"를 역제안 | v1은 고정 기술종류 기준, 개인화 설문은 차기 버전으로 보류(Round 9) |
| 촬영은 실시간 카메라(AR)일 수도 있음 | Round 11: 캡처 방식 확인 | 단일 정지 사진 업로드로 확정 |
| 어느 공이 내 공인지 사진에서 자동으로 알 수 있을 것 | Round 14에서 새로 발견된 간극 | 설정에서 미리 지정, 매번 묻지 않음 |

## Technical Context
그린필드 프로젝트 — 저장소(`danggu`)에 기존 소스 코드 없음. 향후 계획 단계에서 고려할 기술 스택 방향(사용자 미확정, 참고용):
- 프론트엔드: 웹, 모바일 브라우저 카메라/파일 업로드 (`getUserMedia` 또는 `<input type="file" capture>`)
- 비전 인식: 테이블 경계 검출(세그멘테이션/코너 검출) + 공 검출(색상/원형 검출 또는 객체 탐지 모델) + 원근 변환(호모그래피)로 실측 좌표 환산
- 경로 계산: 2D 당구 물리 엔진(쿠션 반사각 계산 포함), 기술종류별 후보 열거 + 난이도(기술위계) 기준 랭킹
- 백엔드/설정 저장: 큐볼 색상 프리셋 저장을 위한 경량 저장소(로컬 스토리지 또는 간단한 서버 설정)

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|----------------|
| Photo | Input | image, viewAngle(oblique 지원), platform(web-mobile-browser) | containsTable, containsBalls |
| Table | Core domain | boundary(4개 모서리, 완전 자동 AI 감지), dimensions | hasBalls |
| Ball | Core domain | color(흰/노랑/빨강×2), position(실측 좌표), role(cueBall/opponentBall/targetBall) | belongsToTable |
| Shot | Core domain | technique(직접/뱅킹/고급), angle, force, difficulty(기술위계 기준, v1 고정), sequence | computedFrom(BallPositions), rankedBy(difficulty) |
| UserProfile *(deferred)* | Supporting | cueBallColor(프리셋), personalDifficultyPreference(v2 예정) | usedFor(cueBall 식별 in v1; 향후 개인화 난이도 in v2) |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|------------------|
| 1 | 4 | 4 | - | - | N/A |
| 2–8 | 4 | 0 | 0 | 4 | 100% |
| 9 | 5 | 1 (UserProfile) | 0 | 4 | 80% |
| 10–16 | 5 | 0 | 0 | 5 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (16 rounds + Round 0 topology gate)</summary>

### Round 0 (Topology)
**Q:** 4개 최상위 컴포넌트(Capture/Vision/Path Calc/Viz) 구성이 맞는가?
**A:** "4구는 흰공 1개, 노란공 1개, 빨간공 2개야" (구성 승인 + 공 구성 정정)

### Round 1 — Path Calculation / Goal
**Q:** "4구의 길을 알려준다"는 게 구체적으로 어떤 결과인가?
**A:** 맞추는 각도/힘 강도까지 정밀 지시 — **Ambiguity: 80%**

### Round 2 — Vision Recognition / Constraint
**Q:** 사진은 탑뷰 고정인가, 사람 시점 비스듬한 각도도 지원해야 하나?
**A:** 사람 시점(비스듬한 각도) 지원 — **Ambiguity: 76%**

### Round 3 — Capture / Constraint
**Q:** 첫 버전(MVP)은 어느 플랫폼인가?
**A:** 웹만 먼저 (모바일 브라우저 카메라) — **Ambiguity: 71%**

### Round 4 — Path Calculation / Success Criteria (Contrarian)
**Q:** 오차가 있는 참고용 가이드라면 어느 정도까지 맞아야 성공인가?
**A:** 실전에서 바로 따라칠 수 있는 수준 — **Ambiguity: 67%**

### Round 5 — Result Visualization / Goal
**Q:** 계산된 경로를 어떻게 보여줘야 하나?
**A:** 정적 다이어그램/도면으로 재구성 — **Ambiguity: 63%**

### Round 6 — Vision Recognition / Constraint (Simplifier)
**Q:** 모서리 확보를 위한 캘리브레이션, 첫 버전에서 어떻게 할까?
**A:** AI가 테이블 경계를 자동 감지 — **Ambiguity: 60%**

### Round 7 — Path Calculation / Constraint
**Q:** 경로 계산 범위(직접샷만? 기술샷 포함?)
**A:** 가능한 모든 기술 추천 후 가장 치기 쉬운 샷 기준 제시, "쉬움" 기준은 별도 정의 필요 — **Ambiguity: 55%**

### Round 8 — Path Calculation / Success Criteria (Ontologist)
**Q:** 샷의 '난이도'를 결정하는 핵심 요소는?
**A:** 사용자가 설문으로 자기 기준을 정의 — **Ambiguity: 55%**

### Round 9 — Topology Amendment (User Profile)
**Q:** 개인화 난이도 기준을 독립 컴포넌트로 다룰지, 설정값으로 다룰지?
**A:** 첫 버전엔 고정 기준으로 대체, 개인화는 나중에 (Deferred) — **Ambiguity: 54%**

### Round 10 — Cross-component / Success Criteria
**Q:** 서비스가 "완성되었다"고 판단하는 테스트 방법은?
**A:** 실제 사용자(본인)가 침으로 따라치면서 검증 — **Ambiguity: 43%** (10라운드 소프트 경고 → 계속 진행 선택)

### Round 11 — Capture / Goal
**Q:** 사진 촬영은 단일 정지 사진인가, 실시간 카메라인가?
**A:** 단일 정지 사진 1장 찍어서 업로드 — **Ambiguity: 37%**

### Round 12 — Result Visualization / Constraint
**Q:** 결과 화면 조작(다른 샷 보기 등) 가능해야 하나?
**A:** 여러 샷 후보 전환 가능 — **Ambiguity: 33%**

### Round 13 — Vision Recognition / Goal
**Q:** 공/모서리가 가려져 인식 실패 시 어떻게 동작?
**A:** 사용자가 직접 보정(터치로 위치 수정) — **Ambiguity: 28%**

### Round 14 — Path Calculation / Goal
**Q:** 사용자의 큐볼이 흰공인지 노랑공인지 시스템이 어떻게 아는가?
**A:** 설정에서 미리 지정(매번 묻지 않음) — **Ambiguity: 25%**

### Round 15 — Cross-component / Constraint (Non-Goals)
**Q:** 이번 버전에서 명확히 제외할 기능은?
**A:** 점수/경기 기록, 멀티플레이어 모두 제외 — **Ambiguity: 22%**

### Round 16 — Cross-component / Success Criteria
**Q:** 몇 번 테스트해서 몇 % 이상이면 MVP 성공으로 볼까?
**A:** 10번 중 7번(70%) 이상 적중하면 성공 — **Ambiguity: 16%** ✅ 임계값(20%) 통과

### Round 17 — Result Visualization / Goal (사용자 요청으로 추가 인터뷰)
**Q:** 샷 후보가 여러 개일 때 몇 개까지 보여줘야 하나?
**A:** 상위 3개만 추려(난이도 순) — **Ambiguity: ~15%**

### Round 18 — Path Calculation / Constraint (Edge case)
**Q:** 유효한 샷이 하나도 없을 때 어떻게 해야 하나?
**A:** 가장 근접한(거의 성공할 법한) 샷을 참고용으로 보여줌 — **Ambiguity: 14%**

</details>
