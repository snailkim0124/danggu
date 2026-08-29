/**
 * Path Calculation API route — thin wrapper around `lib/pathcalc`'s
 * `computeShotPlans` engine (candidate enumeration, rule filter, difficulty
 * ranking, closest-miss fallback — see lib/pathcalc/index.ts).
 */

import { NextResponse } from 'next/server';
import { computeShotPlans } from '@/lib/pathcalc';
import { connectToDatabase } from '@/lib/db/mongo';
import { DEFAULT_SETTINGS, SETTINGS_SINGLETON_ID, SettingsModel } from '@/lib/db/models/Settings';
import type { PathCalcRequest, PathCalcResponse } from '@/lib/uiTypes';
import type { Point, RecognitionResult } from '@/lib/types';

function isPoint(value: unknown): value is Point {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Point).x === 'number' &&
    typeof (value as Point).y === 'number'
  );
}

function isRecognitionResult(value: unknown): value is RecognitionResult {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;

  if (typeof rec.table !== 'object' || rec.table === null) return false;
  const table = rec.table as Record<string, unknown>;
  if (!Array.isArray(table.boundary) || table.boundary.length !== 4 || !table.boundary.every(isPoint)) {
    return false;
  }

  if (!Array.isArray(rec.balls)) return false;
  const ballsValid = rec.balls.every((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const ball = b as Record<string, unknown>;
    return typeof ball.id === 'string' && typeof ball.color === 'string' && typeof ball.role === 'string' && isPoint(ball.position);
  });
  if (!ballsValid) return false;

  return typeof rec.confidence === 'number' && typeof rec.needsManualCorrection === 'boolean';
}

/** Computes up to 3 ranked shot candidates (or one closest-miss fallback) for the given recognition result. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || !isRecognitionResult((body as Record<string, unknown>).recognition)) {
    return NextResponse.json(
      { error: 'Request body must be a PathCalcRequest: { recognition: RecognitionResult }' },
      { status: 400 }
    );
  }

  const { recognition } = body as PathCalcRequest;

  // Fetch the user's settings (cue ball color + skill profile) so ranking can
  // be personalized — see `lib/pathcalc/candidates.ts#personalizedRank`. Best
  // effort: if the DB is unreachable, fall back to `DEFAULT_SETTINGS` (neutral
  // skill profile) rather than failing the whole request, since a shot
  // recommendation with the default ranking is still useful.
  let settings = DEFAULT_SETTINGS;
  try {
    await connectToDatabase();
    const doc = await SettingsModel.findByIdAndUpdate(
      SETTINGS_SINGLETON_ID,
      { $setOnInsert: DEFAULT_SETTINGS },
      { upsert: true, new: true }
    ).lean();
    if (doc) settings = doc;
  } catch {
    // keep DEFAULT_SETTINGS
  }

  let plans;
  try {
    plans = computeShotPlans(recognition, settings);
  } catch (err) {
    // e.g. wrong ball counts/colors — a layout the engine can't resolve into cueBall/opponentBall/redBalls.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Path calculation failed for this layout' },
      { status: 422 }
    );
  }

  const result: PathCalcResponse = {
    shots: plans.map((p) => ({ shot: p.shot, path: p.path })),
    fallback: plans.length > 0 && !plans[0].shot.ruleValid,
  };
  return NextResponse.json(result);
}
