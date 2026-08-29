/**
 * Hand-built `RecognitionResult` fixtures for developing and testing the Path
 * Calculation engine without the Vision module.
 *
 * These are plain coordinate geometry in mm on a rectified table: origin at the
 * bottom-left cushion nose, x along the long side, y along the short side.
 */

import type { Point, RecognitionResult, Settings, TableSize } from '@/lib/types';
import { TABLE_DIMENSIONS_MM } from '@/lib/types';

export interface LayoutSpec {
  cue: Point;
  opponent: Point;
  red1: Point;
  red2: Point;
  size?: TableSize;
  cueBallColor?: 'white' | 'yellow';
  confidence?: number;
}

export const BALL_IDS = {
  cue: 'cue',
  opponent: 'opp',
  red1: 'red-1',
  red2: 'red-2',
} as const;

/** Build a `RecognitionResult` from four mm positions. */
export function makeRecognition(spec: LayoutSpec): RecognitionResult {
  const size = spec.size ?? '대대';
  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[size];
  const cueColor = spec.cueBallColor ?? 'white';
  const opponentColor = cueColor === 'white' ? 'yellow' : 'white';
  const confidence = spec.confidence ?? 1;

  return {
    table: {
      // [topLeft, topRight, bottomRight, bottomLeft] per `TableDetection`'s
      // documented order, expressed in y-up mm space.
      boundary: [
        { x: 0, y: heightMm },
        { x: widthMm, y: heightMm },
        { x: widthMm, y: 0 },
        { x: 0, y: 0 },
      ],
      size,
    },
    balls: [
      { id: BALL_IDS.cue, color: cueColor, role: 'cueBall', position: { ...spec.cue } },
      {
        id: BALL_IDS.opponent,
        color: opponentColor,
        role: 'opponentBall',
        position: { ...spec.opponent },
      },
      { id: BALL_IDS.red1, color: 'red1', role: 'targetBall', position: { ...spec.red1 } },
      { id: BALL_IDS.red2, color: 'red2', role: 'targetBall', position: { ...spec.red2 } },
    ],
    confidence,
    needsManualCorrection: confidence < 0.6,
  };
}

export const WHITE_CUE_SETTINGS: Settings = { cueBallColor: 'white', tableSize: '대대' };

/**
 * Open layout: cue ball with a clear line to both reds, opponent ball parked
 * far away. Should yield comfortable direct-shot candidates.
 */
export const OPEN_LAYOUT = makeRecognition({
  cue: { x: 600, y: 400 },
  opponent: { x: 2200, y: 1100 },
  red1: { x: 1000, y: 600 },
  red2: { x: 1400, y: 380 },
});

/**
 * The opponent ball sits directly on the cue-ball-to-red1 line, so the naive
 * straight shot at red1 fouls. Used to prove the obstruction/foul filter bites.
 */
export const OPPONENT_SCREEN_LAYOUT = makeRecognition({
  cue: { x: 500, y: 635 },
  opponent: { x: 800, y: 635 },
  red1: { x: 1100, y: 635 },
  red2: { x: 1500, y: 900 },
});

/**
 * Reds clustered close to the cue ball with the opponent parked out of the way
 * — short range, generous windows.
 */
export const CLUSTERED_LAYOUT = makeRecognition({
  cue: { x: 700, y: 600 },
  opponent: { x: 2300, y: 200 },
  red1: { x: 1000, y: 660 },
  red2: { x: 1150, y: 560 },
});

/**
 * A layout with genuinely **no** scoring route, for the fallback path: the cue
 * ball is jammed into the bottom-left corner with the opponent ball pinning it
 * diagonally, while both reds are frozen together against the far top-right
 * corner. Every escape line either fouls on the opponent or cannot reach both
 * reds within a plausible stroke.
 */
export const NO_SOLUTION_LAYOUT = makeRecognition({
  cue: { x: 40, y: 40 },
  opponent: { x: 110, y: 110 },
  red1: { x: 2470, y: 1230 },
  red2: { x: 2404, y: 1230 },
});

/**
 * Cue ball tucked right against the bottom rail; both reds sit far enough
 * around that the cleanest scoring routes bank off that near rail *before*
 * touching either red — a genuine 뱅크샷/빈쿠션치기 (cushion before any ball
 * contact), not a 1쿠션/N쿠션 (ball first, then cushion). Used to prove
 * `classifyTechnique` tells the two apart.
 */
export const BANK_SHOT_LAYOUT = makeRecognition({
  cue: { x: 1270, y: 60 },
  opponent: { x: 2400, y: 1200 },
  red1: { x: 900, y: 200 },
  red2: { x: 1700, y: 250 },
});
