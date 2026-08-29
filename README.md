# 당구(danggu) — 4구(사구) 당구 샷 경로 자동 안내 서비스

모바일 웹에서 4구 당구대 사진 한 장을 업로드하면, 테이블 경계와 공 4개(흰공/노랑공/빨간공×2)를 자동으로 인식하고 직접샷부터 뱅킹샷·고급 기술샷까지 가능한 모든 캐롬 경로를 계산해, 실전에서 바로 따라칠 수 있는 각도·힘 수치와 함께 상위 3개 후보를 정적 2D 다이어그램으로 보여주는 서비스입니다. 자세한 요구사항은 `docs/PRD.md`, 구현 계획은 `.omc/plans/danggu-4gu-path-guide-plan.md`를 참고하세요.

## 기술 스택

- **프론트엔드/백엔드**: Next.js (App Router), TypeScript
- **비전 인식(CV)**: OpenCV.js (WASM) — 아래 "OpenCV.js 통합 방식" 참고
- **데이터 저장**: MongoDB Atlas (Mongoose)
- **테스트**: Vitest + @vitejs/plugin-react + jsdom
- **배포**: Vercel

## 시작하기

```bash
npm install
cp .env.local.example .env.local
# .env.local을 열어 MONGODB_URI를 본인의 MongoDB Atlas 클러스터 연결 문자열로 채워주세요.
# (MongoDB Atlas 클러스터 생성은 사람이 직접 https://www.mongodb.com/cloud/atlas 에서 해야 하는 단계입니다.)
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 을 엽니다.

> **주의:** `lib/db/models/*.ts`의 Mongoose 스키마를 수정한 뒤에는 `npm run dev`를 **재시작**해야 합니다.
> 스키마 재등록 에러(OverwriteModelError)를 막는 안전장치 때문에, 이미 떠 있는 개발 서버는 새로 추가된
> 필드를 인식하지 못하고 저장이 조용히 무시될 수 있습니다 (예: 설정 화면에서 값을 바꿔도 다시 불러오면
> 원래대로 돌아가 있는 것처럼 보이는 증상).

### 기타 스크립트

```bash
npm run build      # 프로덕션 빌드
npm run lint       # ESLint
npm test           # Vitest 단위 테스트 실행
npx tsc --noEmit   # 타입 체크만 수행
```

## OpenCV.js 통합 방식

`@techstark/opencv-js` (npm-installable OpenCV.js WASM 빌드)를 `dependencies`에 추가했습니다. 이 패키지는 공식 OpenCV.js WASM 바이너리를 npm 패키지로 감싼 것으로, `import cv from '@techstark/opencv-js'` 형태로 불러와 비전 인식 코드(`lib/vision/`)에서 사용하면 됩니다. Vercel 서버리스 환경에서 네이티브 바인딩(`opencv4nodejs`) 컴파일이 불가능하기 때문에 채택한 방식입니다 (`.omc/plans/danggu-4gu-path-guide-plan.md`의 Technology Stack 참고).

- 브라우저(클라이언트) 측 인식과 서버리스 함수(API Route) 측 인식 중 어디서 OpenCV.js를 실행할지는 `lib/vision/` 구현 시점에 결정합니다. 둘 다 이 패키지로 커버됩니다.
- 콜드스타트/번들 크기에 미치는 영향은 plan Phase 0의 "OpenCV.js(WASM) 초기 로딩/번들 크기 검증" 단계에서 실측 예정입니다.

## 폴더 구조

```
app/                 Next.js App Router 페이지 및 API 라우트
  api/                API 라우트 (recognize/route.ts, settings/route.ts 등 — 다음 단계에서 구현)
components/          React 컴포넌트 (ShotDiagram, PhotoUpload, Settings 등)
lib/
  types.ts            공유 TypeScript 타입 (모든 모듈이 이 계약을 기준으로 개발)
  db/mongo.ts          MongoDB(Mongoose) 서버리스 연결 캐싱 유틸리티
  vision/              Vision Recognition 모듈 (OpenCV.js 기반 테이블/공 인식)
  pathcalc/            Path Calculation 엔진 (샷 후보 생성, 규칙 필터, 난이도 산정)
scripts/             지오메트릭 게이트 등 독립 실행 스크립트
docs/PRD.md          제품 요구사항 문서
.omc/plans/          구현 계획 문서
```

각 폴더의 상세 역할은 폴더 내 `README.md`를 참고하세요.
