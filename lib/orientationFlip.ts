/**
 * Manual "가로/세로 바꾸기" (swap orientation) override for the confirm screen
 * (문제점 #2, follow-up).
 *
 * `lib/vision/camera.ts#alignQuadToTable` auto-picks which pair of detected
 * rail edges is the table's long (2438/2540mm) vs. short (1219/1270mm) side,
 * using a joint-focal-length orthonormality test. That test is provably
 * unreliable on some real "looking down the length of the table" photos —
 * one of its two constraints goes numerically dead in exactly that framing,
 * and can score the *correct* orientation near zero while the wrong one
 * looks confidently self-consistent. Rather than a from-scratch geometric
 * consistency test that could just as easily fail its own edge case, the app
 * lets the user flip the result directly — they know which way their own
 * table runs.
 *
 * Everything here is pure math re-using `lib/vision/camera.ts` — no OpenCV,
 * no network round-trip. `pixelDetection.tableBoundary` (already returned by
 * `/api/recognize`) is enough to recompute either orientation client-side.
 */

// Imported directly from their source files, NOT the `@/lib/vision` barrel:
// that barrel also re-exports `decodeImage` (lib/vision/image.ts), which
// pulls in `sharp` — a Node-only package. This module is used from a client
// component (RecognitionConfirm.tsx), and importing through the barrel drags
// `sharp` into the browser bundle and breaks the build. `camera.ts` and
// `constants.ts` are pure TypeScript with no such dependency.
import { ballImagePointToTableMm, buildTableFrame, type TableFrame } from '@/lib/vision/camera';
import { BALL_RADIUS_MM } from '@/lib/vision/constants';
import type { Ball, Point, TableSize } from '@/lib/types';
import type { PixelDetection } from '@/lib/uiTypes';

/**
 * Both candidate table frames for a detected quad, labeled by which one
 * `alignQuadToTable` would pick automatically (`auto`) vs. the other
 * (`alternate`) — determined by directly comparing `rectangleConsistency`,
 * the same signal the automatic picker uses, so this always agrees with
 * whatever `/api/recognize` actually returned.
 */
export function computeOrientationCandidates(
  tableBoundary: PixelDetection['tableBoundary'],
  size: TableSize,
  imageWidth: number,
  imageHeight: number,
): { auto: TableFrame; alternate: TableFrame } {
  const frame0 = buildTableFrame(tableBoundary, size, imageWidth, imageHeight, 0);
  const frame1 = buildTableFrame(tableBoundary, size, imageWidth, imageHeight, 1);
  return frame0.rectangleConsistency >= frame1.rectangleConsistency
    ? { auto: frame0, alternate: frame1 }
    : { auto: frame1, alternate: frame0 };
}

/** Recompute every ball's mm position (with the z=radius parallax correction
 * already applied) under the given table frame, keyed by ball id — for
 * merging back into a `RecognitionResult.balls` array. */
export function recomputeBallPositions(
  frame: TableFrame,
  pixelBalls: PixelDetection['balls'],
): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const b of pixelBalls) {
    out[b.id] = ballImagePointToTableMm(frame, { x: b.x, y: b.y }, BALL_RADIUS_MM);
  }
  return out;
}

/** Apply recomputed positions onto a ball list, leaving anything not present
 * in `positions` (e.g. a ball the user manually placed off pixelDetection's
 * original set) untouched. */
export function applyBallPositions(balls: Ball[], positions: Record<string, Point>): Ball[] {
  return balls.map((ball) => (positions[ball.id] ? { ...ball, position: positions[ball.id] } : ball));
}
