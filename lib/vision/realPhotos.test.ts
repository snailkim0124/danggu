/**
 * @vitest-environment node
 *
 * Regression tests built from real photos that a user actually hit
 * recognition problems with — see `scripts/fixtures/photos/` and
 * `scripts/diagnose-recognition.ts` (used to diagnose both cases stage by
 * stage before fixing them). Synthetic-scene tests (`pipeline.test.ts`)
 * exercise the pipeline's *geometry* against known ground truth; these
 * exercise it against real-world noise (JPEG artefacts, cast shadows, glare
 * speckle, genuinely oblique angles) that no synthetic render reproduces.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Settings } from '@/lib/types';
import { recognize } from './pipeline';
import { decodeImage } from './image';

const TIMEOUT_MS = 60_000;
const PHOTOS_DIR = path.join(process.cwd(), 'scripts', 'fixtures', 'photos');
const SETTINGS: Settings = { cueBallColor: 'white', tableSize: '대대' };

async function loadPhoto(filename: string) {
  const bytes = await readFile(path.join(PHOTOS_DIR, filename));
  return decodeImage(new Uint8Array(bytes));
}

describe('real photo regressions', () => {
  it(
    // 문제점: 공 1개("적구") 옆의 진한 그림자가 별도의 공으로 잘못 쪼개지고
    // (balls.ts#trySplitMergedBlob), 천 위 글레어/먼지 얼룩이 원형·크기 조건을
    // 통과해 후보 풀을 오염시켜(둘 다 이 테스트가 추가되기 전에는 실제로
    // 발생했음), 정작 그림자로 인해 낮은 점수를 받은 진짜 공이 상위 4개에서
    // 밀려났었다. 두 문제 모두 좁은 범위의 알고리즘 버그로 진단·수정됨(밝기
    // 상대 비교 + 쿠션 색상 근접 판정) — 애매한 케이스로 취급해 confidence만
    // 낮추는 것은 부적절했다: 이 사진 자체는 조명·각도가 좋은 깨끗한 사진이라
    // 실제로는 4개 모두 정확히 찾아낼 수 있어야 하는 경우였다.
    'recognises all 4 balls in 에러1.jpg (ball + shadow mis-split as two balls)',
    async () => {
      const image = await loadPhoto('에러1.jpg');
      const { recognition, diagnostics } = await recognize(image, SETTINGS);

      expect(recognition.balls, `diagnostics ${JSON.stringify(diagnostics)}`).toHaveLength(4);
      expect(new Set(recognition.balls.map((b) => b.color))).toEqual(
        new Set(['white', 'yellow', 'red1', 'red2'])
      );
      // A clean, well-lit, nearly top-down photo — should be confidently
      // recognised outright, not bounced to manual correction.
      expect(recognition.confidence, `diagnostics ${JSON.stringify(diagnostics)}`).toBeGreaterThan(0.7);
      expect(recognition.needsManualCorrection).toBe(false);
    },
    TIMEOUT_MS
  );

  it(
    // 문제점: 매우 비스듬한 각도(테이블 길이 방향에 가깝게 내려다봄) +
    // 붙어있는 두 공(빨강/노랑) 조합. 쿠션 라인 피팅 잔차가 크게 나빠서
    // (tableFit 신뢰도 ~0.06) 전체 confidence가 임계값 아래로 떨어지는데,
    // 이건 알고리즘이 틀린 게 아니라 실제로 애매한 촬영 각도라서 그런 것 —
    // 붙어있는 두 공 자체는 (trySplitMergedBlob 덕에) 대체로 잘 찾아낸다.
    // 이 테스트는 "애매한 케이스는 조용히 틀리지 않고 uncertain으로 넘어가야
    // 한다"는 걸 고정해두는 회귀 테스트: recognize()가 크래시하지 않으면서도
    // needsManualCorrection이 true여야 한다.
    '에러2.jpg (극단적으로 비스듬한 각도 + 붙어있는 공) flags low confidence instead of guessing silently',
    async () => {
      const image = await loadPhoto('에러2.jpg');
      const { recognition, diagnostics } = await recognize(image, SETTINGS);

      expect(recognition.balls, `diagnostics ${JSON.stringify(diagnostics)}`).toHaveLength(4);
      // The whole point: a genuinely hard photo must not come back confident.
      expect(
        recognition.needsManualCorrection,
        `diagnostics ${JSON.stringify(diagnostics)}`
      ).toBe(true);
      expect(diagnostics.confidence.tableFit).toBeLessThan(0.6);
    },
    TIMEOUT_MS
  );
});
