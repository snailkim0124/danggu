# Vercel 배포 가이드

이 프로젝트를 Vercel에 배포하는 절차와, 배포 시 알아둬야 할 서버리스 제약 사항을 정리합니다.

## 1. 배포 절차

1. **저장소 연결**: [Vercel 대시보드](https://vercel.com/new)에서 "Add New Project" → 이 GitHub 저장소를 선택해 import합니다. (아직 GitHub에 push하지 않았다면 먼저 push부터 하세요.)
2. **프레임워크 감지 확인**: Vercel이 Next.js 프로젝트를 자동으로 인식해 Build Command(`next build`)와 Output Directory를 자동 설정합니다. 이 프로젝트는 저장소 루트가 곧 Next.js 앱 루트이므로 Root Directory는 기본값(`.`) 그대로 두면 됩니다.
3. **환경 변수 설정**: Vercel 프로젝트의 **Settings → Environment Variables**에서 `MONGODB_URI`를 추가합니다.
   - 로컬 `.env.local`에 설정한 것과 **같은 MongoDB Atlas 클러스터**의 연결 문자열을 사용하거나, 프로덕션용으로 별도 데이터베이스/클러스터를 쓰고 싶다면 그 연결 문자열을 사용하세요.
   - Production / Preview / Development 환경 각각에 필요에 따라 지정합니다 (최소한 Production에는 반드시 설정).
   - Atlas 클러스터의 **Network Access**에서 Vercel의 서버리스 함수가 접속할 수 있도록 IP 허용 목록을 `0.0.0.0/0`(모든 IP 허용) 또는 Atlas의 "Allow access from anywhere" 옵션으로 설정해야 합니다 — Vercel 서버리스 함수는 고정 IP가 아니므로 특정 IP만 허용하면 연결이 실패합니다.
4. **배포**: "Deploy" 클릭. 첫 배포가 끝나면 이후로는 저장소에 push할 때마다 자동으로 재배포됩니다 (Preview 배포는 PR/브랜치별, Production 배포는 기본 브랜치 push 시).
5. **배포 후 확인**: 배포된 URL에서 `/api/settings`에 GET 요청을 보내 200과 함께 기본 설정값이 오는지 확인하면, MongoDB 연결(환경 변수 + 네트워크 허용 목록)이 제대로 되어 있다는 뜻입니다.

## 2. 빌드 설정 체크리스트

- Node.js 버전: 로컬 개발 환경(v24)과 Vercel의 기본 Node 버전이 다를 수 있습니다. 특이 동작이 보이면 Vercel 프로젝트 Settings → General → Node.js Version에서 버전을 맞춰보세요.
- `next.config.ts`의 `serverExternalPackages: ["@techstark/opencv-js"]` 설정이 커밋에 포함되어 있는지 확인하세요 (§4 참고 — 없으면 빌드가 느려지거나 함수 번들이 불필요하게 커집니다).
- `.env.local`은 `.gitignore`에 포함되어 있어 저장소에 올라가지 않습니다 — Vercel 환경 변수는 **반드시 대시보드에서 별도로 설정**해야 합니다. (`.env.local`을 커밋해서 해결하려고 하면 안 됩니다 — 자격 증명 유출.)

## 3. Vercel 서버리스 실행시간/메모리 제약 (plan Risk 반영)

Vercel 서버리스 함수는 실행시간과 메모리에 제한이 있고, `@techstark/opencv-js`(OpenCV.js WASM) 기반의 비전 인식 연산은 이 제한에 걸리기 쉽습니다:

- **실행시간**: 플랜별로 기본 제한이 다릅니다 (Hobby 기본 10초, Pro 기본 15초 — 최대치는 `vercel.json`의 `functions.maxDuration` 또는 함수별 `export const maxDuration`으로 늘릴 수 있으나 플랜 한도 안에서만 가능합니다). 고해상도 사진의 라인 검출·호모그래피 계산이 이 시간을 넘기면 타임아웃으로 실패합니다.
- **메모리**: 함수당 기본 메모리 할당량이 있고(플랜/설정에 따라 조정 가능), OpenCV.js 모듈 자체를 로드하는 데만 대략 100MB 내외의 RSS가 필요합니다(직접 측정 확인). 여기에 업로드된 이미지 처리(디코딩/리사이즈)와 Next.js·mongoose 등 나머지 런타임 오버헤드가 더해집니다.
- **완화책 (Phase 1에서 이미 구현됨)**: 업로드 이미지를 처리 전에 다운스케일(예: 최대 변 1600px)하는 것이 실행시간·메모리 부담을 줄이는 핵심 조치입니다 — `lib/vision`에서 담당. 이 조치 없이 원본 고해상도 사진을 그대로 CV 파이프라인에 넣으면 타임아웃/메모리 초과 위험이 커집니다.
- **권장**: `recognize` API 라우트를 실제로 배포한 뒤, 다양한 해상도의 사진으로 실행시간을 실측해 Vercel 함수 로그(Vercel 대시보드 → 프로젝트 → Logs, 또는 `vercel logs`)에서 확인하세요. plan Phase 1 검증 항목("서버리스 함수 실행시간 측정")과 연결됩니다.

## 4. OpenCV.js(WASM) 관련 Next.js 설정

`@techstark/opencv-js`는 OpenCV.js를 약 13MB짜리 **단일 파일**로 배포하며, WASM 바이너리가 그 파일 안에 내장되어 있습니다 (별도의 `.wasm` 파일을 따로 서빙할 필요가 없음 — 직접 `require`해서 검증함: 파일시스템 접근 없이 자체적으로 초기화됩니다).

- **웹팩/터보팩 WASM 로더 설정(`experiments.asyncWebAssembly` 등)은 필요 없습니다.** 별도 `.wasm` 에셋을 번들러가 직접 로드하는 방식이 아니라, 순수 JS(CommonJS/UMD)로 실행되는 파일이기 때문입니다.
- **필요했던 설정**: `next.config.ts`에 `serverExternalPackages: ["@techstark/opencv-js"]`를 추가했습니다. Next.js는 기본적으로 Server Components/Route Handler에서 쓰는 의존성을 웹팩/터보팩으로 번들링하는데, 이미 완전히 빌드된 13MB짜리 파일(내부에 바이너리 데이터 포함)을 다시 번들링하면 빌드가 느려지고 함수 번들 용량만 커집니다. `serverExternalPackages`는 해당 패키지를 번들링에서 제외하고 런타임에 Node.js의 일반 `require()`로 그대로 불러오게 합니다.
  - 참고로 `mongoose`와 `sharp`(이미지 처리용, `lib/vision` 담당)는 Next.js가 이미 기본 제외 목록에 포함하고 있어 별도 설정이 필요 없었습니다 — `@techstark/opencv-js`만 목록에 없어 추가했습니다.
- **런타임 주의사항**: `@techstark/opencv-js`는 Node.js의 CommonJS `require`/`module` 객체에 의존합니다. 이 패키지를 쓰는 API 라우트(`app/api/recognize/route.ts` 등)에는 **`export const runtime = 'edge'`를 절대 설정하면 안 됩니다** — Edge 런타임은 Node.js API가 없는 별도 실행 환경이라 로드 자체가 실패합니다. App Router의 Route Handler는 기본값이 Node.js 런타임이므로, 별도로 `runtime`을 지정하지만 않으면 문제 없습니다.
- **초기화 방식 참고**: 이 버전(`5.0.0-release.1`)은 `require('@techstark/opencv-js')`가 **Promise를 반환**합니다 (구버전 문서의 `cv.onRuntimeInitialized` 콜백 방식이 아님 — 두 방식 모두 지원하도록 되어 있으니 패키지 README의 "Basic Usage" 예제 코드를 그대로 따르면 안전합니다). `lib/vision` 구현 시 참고하세요.

## 5. 참고 문서

- `.omc/plans/danggu-4gu-path-guide-plan.md` — Technology Stack, Risks and Mitigations
- `docs/testing/geometric-gate-guide.md`, `docs/testing/play-gate-checklist.md` — 배포 후 정확도/실전 검증
