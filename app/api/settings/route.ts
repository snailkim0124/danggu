/**
 * Settings API route — GET/POST for the app's single Settings singleton
 * (cue ball color + table size preset). See `lib/db/models/Settings.ts` for
 * the schema/storage shape and `lib/types.ts` for the `Settings` contract.
 */

import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/db/mongo';
import { DEFAULT_SETTINGS, SETTINGS_SINGLETON_ID, SettingsModel } from '@/lib/db/models/Settings';
import { SKILL_CATEGORIES, type Settings, type SkillProfile, type TableSize } from '@/lib/types';

const CUE_BALL_COLORS = ['white', 'yellow'] as const;
const TABLE_SIZES = ['대대', '중대'] as const;
const SKILL_LEVELS = [1, 2, 3, 4, 5] as const;

function isCueBallColor(value: unknown): value is Settings['cueBallColor'] {
  return (CUE_BALL_COLORS as readonly unknown[]).includes(value);
}

function isTableSize(value: unknown): value is TableSize {
  return (TABLE_SIZES as readonly unknown[]).includes(value);
}

function isSkillProfile(value: unknown): value is SkillProfile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return SKILL_CATEGORIES.every((c) => (SKILL_LEVELS as readonly unknown[]).includes(obj[c]));
}

/** Shape the response body strictly as `Settings` — never leak `_id`/Mongo internals. */
function toSettingsPayload(doc: Settings): Settings {
  return { cueBallColor: doc.cueBallColor, tableSize: doc.tableSize, skillProfile: doc.skillProfile };
}

/** Returns the current settings, creating the default singleton document if none exists yet. */
export async function GET() {
  await connectToDatabase();

  const doc = await SettingsModel.findByIdAndUpdate(
    SETTINGS_SINGLETON_ID,
    { $setOnInsert: DEFAULT_SETTINGS },
    { upsert: true, new: true }
  ).lean();

  return NextResponse.json(toSettingsPayload(doc));
}

/** Validates and upserts the settings singleton. 400s on any unrecognized enum value. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const { cueBallColor, tableSize, skillProfile } = body as Record<string, unknown>;

  if (!isCueBallColor(cueBallColor)) {
    return NextResponse.json(
      { error: `cueBallColor must be one of: ${CUE_BALL_COLORS.join(', ')}` },
      { status: 400 }
    );
  }

  if (!isTableSize(tableSize)) {
    return NextResponse.json(
      { error: `tableSize must be one of: ${TABLE_SIZES.join(', ')}` },
      { status: 400 }
    );
  }

  if (!isSkillProfile(skillProfile)) {
    return NextResponse.json(
      {
        error: `skillProfile must have a level 1-5 for each of: ${SKILL_CATEGORIES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  await connectToDatabase();

  const doc = await SettingsModel.findByIdAndUpdate(
    SETTINGS_SINGLETON_ID,
    { $set: { cueBallColor, tableSize, skillProfile } },
    { upsert: true, new: true, runValidators: true }
  ).lean();

  return NextResponse.json(toSettingsPayload(doc));
}
