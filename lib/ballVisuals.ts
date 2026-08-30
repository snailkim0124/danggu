/**
 * Shared ball rendering constants (colour swatch + Korean label) for every
 * component that draws a `Ball` — `RecognitionConfirm`, `BallPositionEditor`,
 * `ShotDiagram`. Frontend-local presentation data, like `lib/railMarkers.ts` —
 * not part of the `lib/types.ts` contract.
 *
 * Previously each component kept its own copy of these two maps; centralised
 * here so a colour/label change can't drift between screens.
 */

import type { BallColor } from './types';

export const BALL_DISPLAY_COLOR: Record<BallColor, string> = {
  white: '#f5f5f5',
  yellow: '#f4c430',
  red1: '#d9291c',
  red2: '#d9291c',
};

export const BALL_LABEL: Record<BallColor, string> = {
  white: '흰공',
  yellow: '노랑공',
  red1: '빨간공',
  red2: '빨간공',
};
