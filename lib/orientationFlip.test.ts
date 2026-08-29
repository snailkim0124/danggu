/**
 * "가로/세로 바꾸기" manual override tests, against the exact real photo quad
 * that exposed the bug (a "looking down the length of the table" shot where
 * `alignQuadToTable`'s automatic scoring picks the wrong orientation — see
 * `lib/orientationFlip.ts`'s module doc).
 */

import { describe, expect, it } from 'vitest';
import { applyBallPositions, computeOrientationCandidates, recomputeBallPositions } from './orientationFlip';
import type { PixelDetection } from '@/lib/uiTypes';
import type { Ball } from '@/lib/types';

// Real detected pixel quad from a user-submitted photo shot end-on, down the
// table's length (당구3.jpg) — the exact case that triggered this feature.
const REAL_QUAD: PixelDetection['tableBoundary'] = [
  { x: 200.01937660265347, y: 30.806978099093854 },
  { x: 545.6883417196111, y: 25.803639708045292 },
  { x: 713.8713916575133, y: 370.05650605870704 },
  { x: 42.4835851839984, y: 376.60617145515994 },
];
const IMAGE_WIDTH = 775;
const IMAGE_HEIGHT = 429;

const PIXEL_BALLS: PixelDetection['balls'] = [
  { id: 'white', color: 'white', role: 'cueBall', x: 130, y: 300, radiusPx: 28 },
  { id: 'yellow', color: 'yellow', role: 'opponentBall', x: 370, y: 95, radiusPx: 14 },
  { id: 'red1', color: 'red1', role: 'targetBall', x: 265, y: 130, radiusPx: 17 },
  { id: 'red2', color: 'red2', role: 'targetBall', x: 520, y: 270, radiusPx: 22 },
];

describe('computeOrientationCandidates', () => {
  it('labels the higher-rectangleConsistency frame as auto, matching what /api/recognize would pick', () => {
    const { auto, alternate } = computeOrientationCandidates(REAL_QUAD, '중대', IMAGE_WIDTH, IMAGE_HEIGHT);
    expect(auto.rectangleConsistency).toBeGreaterThanOrEqual(alternate.rectangleConsistency);
    // This specific photo is the known bad case: rectangleConsistency alone
    // picks the *wrong* orientation with high confidence (this assertion
    // documents the bug the flip button exists to work around, not a
    // desirable property — see the module doc).
    expect(auto.rectangleConsistency).toBeGreaterThan(0.5);
  });

  it('produces two genuinely different frames, not the same one twice', () => {
    const { auto, alternate } = computeOrientationCandidates(REAL_QUAD, '중대', IMAGE_WIDTH, IMAGE_HEIGHT);
    expect(auto.pose.centerMm).not.toEqual(alternate.pose.centerMm);
  });
});

describe('recomputeBallPositions / applyBallPositions', () => {
  it('produces materially different ball positions under the auto vs. alternate frame', () => {
    const { auto, alternate } = computeOrientationCandidates(REAL_QUAD, '중대', IMAGE_WIDTH, IMAGE_HEIGHT);
    const posAuto = recomputeBallPositions(auto, PIXEL_BALLS);
    const posAlt = recomputeBallPositions(alternate, PIXEL_BALLS);

    for (const b of PIXEL_BALLS) {
      const a = posAuto[b.id];
      const c = posAlt[b.id];
      const moved = Math.hypot(a.x - c.x, a.y - c.y);
      // Swapping which rail pair is long/short is a large geometric change,
      // not a rounding-level difference -- expect at least tens of mm.
      expect(moved).toBeGreaterThan(50);
    }
  });

  it('applyBallPositions updates matching ids and leaves the rest untouched', () => {
    const balls: Ball[] = [
      { id: 'white', color: 'white', role: 'cueBall', position: { x: 0, y: 0 } },
      { id: 'not-in-pixel-set', color: 'yellow', role: 'opponentBall', position: { x: 9, y: 9 } },
    ];
    const updated = applyBallPositions(balls, { white: { x: 111, y: 222 } });
    expect(updated[0].position).toEqual({ x: 111, y: 222 });
    expect(updated[1].position).toEqual({ x: 9, y: 9 }); // untouched
  });
});
