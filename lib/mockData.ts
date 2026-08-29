/**
 * Mock/placeholder data generators for the frontend flow.
 *
 * `lib/pathcalc` (shot candidates) is wired to the real engine now (see
 * app/api/path-calc/route.ts) — only `lib/vision` (recognition) doesn't have
 * an `/api/recognize` route yet, so `mockRecognitionResult`/
 * `approximatePixelDetection` below stand in for it. Every shape here is
 * built strictly from `lib/types.ts` (plus the additive `lib/uiTypes.ts`),
 * so swapping in the real recognition response later requires no
 * consumer-side changes.
 */

import { TABLE_DIMENSIONS_MM } from './types';
import type { Ball, Point, RecognitionResult, Settings, TableGeometry } from './types';
import type { ApproximatePixelDetection } from './uiTypes';

/** Builds a plausible mm-space table + 4 balls, respecting the user's cue ball color setting. */
export function mockRecognitionResult(settings: Settings): RecognitionResult {
  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[settings.tableSize];
  const margin = 150;

  const table: TableGeometry = {
    boundary: [
      { x: margin, y: margin },
      { x: widthMm - margin, y: margin },
      { x: widthMm - margin, y: heightMm - margin },
      { x: margin, y: heightMm - margin },
    ],
    size: settings.tableSize,
  };

  const opponentColor = settings.cueBallColor === 'white' ? 'yellow' : 'white';

  const balls: Ball[] = [
    { id: 'cue', color: settings.cueBallColor, role: 'cueBall', position: { x: widthMm * 0.28, y: heightMm * 0.62 } },
    { id: 'opponent', color: opponentColor, role: 'opponentBall', position: { x: widthMm * 0.7, y: heightMm * 0.25 } },
    { id: 'red1', color: 'red1', role: 'targetBall', position: { x: widthMm * 0.55, y: heightMm * 0.4 } },
    { id: 'red2', color: 'red2', role: 'targetBall', position: { x: widthMm * 0.75, y: heightMm * 0.7 } },
  ];

  return { table, balls, confidence: 0.92, needsManualCorrection: false };
}

/** Derives a pixel-space overlay by fitting the mm layout into an image-sized box. Not a real perspective projection. */
export function approximatePixelDetection(
  recognition: RecognitionResult,
  imageWidth: number,
  imageHeight: number
): ApproximatePixelDetection {
  const xs = recognition.table.boundary.map((p) => p.x);
  const ys = recognition.table.boundary.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const mmWidth = maxX - minX || 1;
  const mmHeight = maxY - minY || 1;

  const padX = imageWidth * 0.08;
  const padY = imageHeight * 0.08;
  const availW = imageWidth - padX * 2;
  const availH = imageHeight - padY * 2;
  const scale = Math.min(availW / mmWidth, availH / mmHeight);

  const toPixel = (p: { x: number; y: number }) => ({
    x: padX + (p.x - minX) * scale,
    y: padY + (p.y - minY) * scale,
  });

  const [a, b, c, d] = recognition.table.boundary;
  const radiusPx = Math.min(imageWidth, imageHeight) * 0.025;
  // Not a real perspective detection, so there's no separate "outer rail"
  // contour to approximate — same quad as `tableBoundary`.
  const boundaryPx: [Point, Point, Point, Point] = [toPixel(a), toPixel(b), toPixel(c), toPixel(d)];

  return {
    tableBoundary: boundaryPx,
    outerTableBoundary: boundaryPx,
    balls: recognition.balls.map((ball) => {
      const p = toPixel(ball.position);
      return { id: ball.id, color: ball.color, role: ball.role, x: p.x, y: p.y, radiusPx };
    }),
    imageWidth,
    imageHeight,
    approximate: true,
  };
}
