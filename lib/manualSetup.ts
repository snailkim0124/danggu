/**
 * Pure helpers for the "수동 배치 모드" entry point (`app/manual-setup/page.tsx`)
 * — a new entry point that skips Capture/Vision Recognition entirely and lets
 * the user place all 4 balls directly, then reuses Path Calculation and
 * Result Visualization unchanged. See PRD.md/PLAN.md discussion (2026-08-30)
 * for why this exists; not yet documented as a formal P0/P1 line item.
 *
 * Kept separate from the page component (`'use client'`, no logic worth unit
 * testing on its own) so the actual ratio<->mm math and `RecognitionResult`
 * assembly — the parts that can silently be wrong — have real tests, matching
 * how the rest of this codebase keeps pure calculation in `lib/` and UI
 * wiring in `app/`/`components/` (see e.g. `lib/railMarkers.ts` vs.
 * `components/ShotDiagram.tsx`).
 */

import { TABLE_DIMENSIONS_MM } from './types';
import type { Ball, BallColor, Point, RecognitionResult, Settings, TableGeometry } from './types';
import { BALL_RADIUS_MM } from './vision/constants';

/** The 4 balls this flow always places, keyed by role rather than physical
 * color — `cue`/`opponent` resolve to white/yellow via `Settings.cueBallColor`
 * (see `manualBallColor`), same id scheme `lib/mockData.ts#mockRecognitionResult`
 * already uses for its placeholder layout. */
export type ManualBallKey = 'cue' | 'opponent' | 'red1' | 'red2';

export const MANUAL_BALL_KEYS: ManualBallKey[] = ['cue', 'opponent', 'red1', 'red2'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Table boundary in the cushion-nose-line mm frame — the exact rectangle
 * `lib/vision/table.ts#rectifiedBoundary` builds for a real recognition, but
 * duplicated here as a literal rather than imported: that module pulls in
 * the OpenCV/sharp vision pipeline (Node-only), which must never enter this
 * page's client bundle (see the import comment on `lib/orientationFlip.ts`
 * for the same constraint on `RecognitionConfirm.tsx`).
 */
export function manualTableBoundary(widthMm: number, heightMm: number): [Point, Point, Point, Point] {
  return [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];
}

/**
 * Ratio -> mm, in the same (x, y) convention
 * `docs/testing/play-gate-checklist.md` §3 documents (x=0/1 the two short
 * cushions, y=0/1 the two long cushions) — so a play-gate/geometric-gate
 * layout already written down as ratios can be typed into this page verbatim
 * and reproduced exactly. Clamped to keep the ball's full radius on the
 * table, same bound `BallPositionEditor`'s drag uses — a ball can be typed to
 * (0, 0) but still renders resting against the cushion, not centred on it.
 */
export function ratioToMm(ratio: Point, widthMm: number, heightMm: number): Point {
  return {
    x: clamp(ratio.x * widthMm, BALL_RADIUS_MM, widthMm - BALL_RADIUS_MM),
    y: clamp(ratio.y * heightMm, BALL_RADIUS_MM, heightMm - BALL_RADIUS_MM),
  };
}

/** mm -> ratio, the inverse display direction (drag moves mm; the ratio
 * inputs need to reflect that live). Not clamped — callers read this only to
 * populate a display/edit field, and `ratioToMm` re-clamps on the way back. */
export function mmToRatio(mm: Point, widthMm: number, heightMm: number): Point {
  return { x: mm.x / widthMm, y: mm.y / heightMm };
}

/** Resolves a role-keyed ball to its physical color under the user's cue-ball
 * setting — `cue`/`opponent` are whichever of white/yellow the setting picks,
 * red1/red2 are fixed. */
export function manualBallColor(key: ManualBallKey, cueBallColor: Settings['cueBallColor']): BallColor {
  switch (key) {
    case 'cue':
      return cueBallColor;
    case 'opponent':
      return cueBallColor === 'white' ? 'yellow' : 'white';
    case 'red1':
      return 'red1';
    case 'red2':
      return 'red2';
  }
}

/** Default starting layout (ratio space, all 4 keys) — spread out and
 * non-overlapping, the same relative arrangement
 * `lib/mockData.ts#mockRecognitionResult` uses for its placeholder balls, so
 * this page opens on a sane, already-valid setup instead of 4 stacked balls
 * the user must untangle before anything computes. */
export const DEFAULT_MANUAL_RATIO_POSITIONS: Record<ManualBallKey, Point> = {
  cue: { x: 0.28, y: 0.62 },
  opponent: { x: 0.7, y: 0.25 },
  red1: { x: 0.55, y: 0.4 },
  red2: { x: 0.75, y: 0.7 },
};

/**
 * Assembles a `RecognitionResult` straight from manually-placed mm positions
 * — the type Path Calculation (`computeShotPlans`, `/api/path-calc`) already
 * consumes, unchanged. No Photo/Vision Recognition step ran in this flow, so
 * `confidence`/`needsManualCorrection` are not computed or borrowed from
 * anywhere — they carry their honest values for "the user specified this
 * directly" (full confidence, no correction needed), not a stand-in for a
 * recognition score that was never produced.
 */
export function buildManualRecognitionResult(
  settings: Settings,
  mmPositions: Record<ManualBallKey, Point>,
): RecognitionResult {
  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[settings.tableSize];

  const balls: Ball[] = [
    { id: 'cue', color: manualBallColor('cue', settings.cueBallColor), role: 'cueBall', position: mmPositions.cue },
    {
      id: 'opponent',
      color: manualBallColor('opponent', settings.cueBallColor),
      role: 'opponentBall',
      position: mmPositions.opponent,
    },
    { id: 'red1', color: 'red1', role: 'targetBall', position: mmPositions.red1 },
    { id: 'red2', color: 'red2', role: 'targetBall', position: mmPositions.red2 },
  ];

  const table: TableGeometry = { boundary: manualTableBoundary(widthMm, heightMm), size: settings.tableSize };

  return { table, balls, confidence: 1, needsManualCorrection: false };
}
