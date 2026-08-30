import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANUAL_RATIO_POSITIONS,
  MANUAL_BALL_KEYS,
  buildManualRecognitionResult,
  manualBallColor,
  manualTableBoundary,
  mmToRatio,
  ratioToMm,
} from './manualSetup';
import { computeShotPlans } from './pathcalc';
import { BALL_RADIUS_MM } from './vision/constants';
import { TABLE_DIMENSIONS_MM, type Settings } from './types';

describe('manualTableBoundary', () => {
  it('matches the cushion-nose-line rectangle lib/vision/table.ts#rectifiedBoundary builds', () => {
    expect(manualTableBoundary(2438, 1219)).toEqual([
      { x: 0, y: 0 },
      { x: 2438, y: 0 },
      { x: 2438, y: 1219 },
      { x: 0, y: 1219 },
    ]);
  });
});

describe('ratioToMm / mmToRatio', () => {
  const widthMm = 2438;
  const heightMm = 1219;

  it('maps (0.5, 0.5) to the table centre', () => {
    expect(ratioToMm({ x: 0.5, y: 0.5 }, widthMm, heightMm)).toEqual({ x: widthMm / 2, y: heightMm / 2 });
  });

  it('clamps (0, 0) and (1, 1) to a full ball radius inside the cushion, not the corner itself', () => {
    expect(ratioToMm({ x: 0, y: 0 }, widthMm, heightMm)).toEqual({ x: BALL_RADIUS_MM, y: BALL_RADIUS_MM });
    expect(ratioToMm({ x: 1, y: 1 }, widthMm, heightMm)).toEqual({
      x: widthMm - BALL_RADIUS_MM,
      y: heightMm - BALL_RADIUS_MM,
    });
  });

  it('round-trips a mid-table point through mm and back to ratio', () => {
    const ratio = { x: 0.25, y: 0.3 };
    const mm = ratioToMm(ratio, widthMm, heightMm);
    expect(mmToRatio(mm, widthMm, heightMm)).toEqual(ratio);
  });

  it('reproduces a play-gate-checklist.md layout row exactly (배치 #1 큐볼)', () => {
    // docs/testing/play-gate-checklist.md §4, row 1: 큐볼 (0.25, 0.30).
    const mm = ratioToMm({ x: 0.25, y: 0.3 }, widthMm, heightMm);
    expect(mm).toEqual({ x: widthMm * 0.25, y: heightMm * 0.3 });
  });
});

describe('manualBallColor', () => {
  it('resolves cue/opponent from Settings.cueBallColor, and reds fixed', () => {
    expect(manualBallColor('cue', 'white')).toBe('white');
    expect(manualBallColor('opponent', 'white')).toBe('yellow');
    expect(manualBallColor('cue', 'yellow')).toBe('yellow');
    expect(manualBallColor('opponent', 'yellow')).toBe('white');
    expect(manualBallColor('red1', 'white')).toBe('red1');
    expect(manualBallColor('red2', 'yellow')).toBe('red2');
  });
});

describe('buildManualRecognitionResult', () => {
  const settings: Settings = { cueBallColor: 'yellow', tableSize: '대대' };
  const mmPositions = Object.fromEntries(
    MANUAL_BALL_KEYS.map((key) => [key, ratioToMm(DEFAULT_MANUAL_RATIO_POSITIONS[key], 2540, 1270)]),
  ) as Record<(typeof MANUAL_BALL_KEYS)[number], { x: number; y: number }>;

  it('carries honest confidence/needsManualCorrection — no recognition ever ran', () => {
    const result = buildManualRecognitionResult(settings, mmPositions);
    expect(result.confidence).toBe(1);
    expect(result.needsManualCorrection).toBe(false);
  });

  it('assigns roles/colors per Settings.cueBallColor, not a hardcoded one', () => {
    const result = buildManualRecognitionResult(settings, mmPositions);
    const cue = result.balls.find((b) => b.id === 'cue')!;
    const opponent = result.balls.find((b) => b.id === 'opponent')!;
    expect(cue.color).toBe('yellow');
    expect(cue.role).toBe('cueBall');
    expect(opponent.color).toBe('white');
    expect(opponent.role).toBe('opponentBall');
    expect(result.balls.filter((b) => b.role === 'targetBall').map((b) => b.color).sort()).toEqual(['red1', 'red2']);
  });

  it('builds the boundary from the selected table size preset, not a fixed one', () => {
    const { widthMm, heightMm } = TABLE_DIMENSIONS_MM['대대'];
    const result = buildManualRecognitionResult(settings, mmPositions);
    expect(result.table.size).toBe('대대');
    expect(result.table.boundary).toEqual(manualTableBoundary(widthMm, heightMm));
  });

  it('produces a RecognitionResult that Path Calculation accepts unchanged (no confidence/photo special-casing)', () => {
    const result = buildManualRecognitionResult(settings, mmPositions);
    // The real assertion is simply that this doesn't throw — computeShotPlans
    // is the exact function `/api/path-calc` calls for a real photo-derived
    // recognition, so accepting this input unmodified is what "reuses Path
    // Calculation as-is" actually means.
    const plans = computeShotPlans(result, settings);
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeLessThanOrEqual(3);
  });
});
