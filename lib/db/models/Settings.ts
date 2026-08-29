/**
 * Mongoose model for the user-configurable `Settings` (see `lib/types.ts`).
 *
 * v1 has no auth/accounts, so there is exactly one settings document for the
 * whole app — a fixed singleton keyed by `_id: SETTINGS_SINGLETON_ID`. GET
 * and POST in `app/api/settings/route.ts` always read/write this one
 * document. When multi-user accounts arrive, this is the model to key by
 * user id instead of a fixed singleton id.
 */

import mongoose, { Schema, type Model } from 'mongoose';
import { DEFAULT_SKILL_PROFILE, SKILL_CATEGORIES, type Settings, type SkillProfile } from '@/lib/types';

/** Fixed `_id` for the one-and-only Settings document (no accounts in v1). */
export const SETTINGS_SINGLETON_ID = 'default';

/** Defaults used when no settings document exists yet. */
export const DEFAULT_SETTINGS: Settings = {
  cueBallColor: 'white',
  tableSize: '중대',
  skillProfile: DEFAULT_SKILL_PROFILE,
};

export interface SettingsDocument extends Settings {
  _id: string;
}

const skillLevelField = {
  type: Number,
  enum: [1, 2, 3, 4, 5],
  required: true,
  default: 3,
} as const;

const skillProfileSchema = new Schema<SkillProfile>(
  Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, skillLevelField])),
  { _id: false },
);

const settingsSchema = new Schema<SettingsDocument>(
  {
    _id: { type: String, default: SETTINGS_SINGLETON_ID },
    cueBallColor: {
      type: String,
      enum: ['white', 'yellow'],
      required: true,
      default: DEFAULT_SETTINGS.cueBallColor,
    },
    tableSize: {
      type: String,
      enum: ['대대', '중대'],
      required: true,
      default: DEFAULT_SETTINGS.tableSize,
    },
    skillProfile: {
      type: skillProfileSchema,
      required: true,
      default: () => ({ ...DEFAULT_SKILL_PROFILE }),
    },
  },
  {
    collection: 'settings',
    versionKey: false,
  }
);

// Guard against Next.js dev-mode hot-reload (and repeated test imports)
// re-registering the same model and throwing OverwriteModelError.
export const SettingsModel: Model<SettingsDocument> =
  (mongoose.models.Settings as Model<SettingsDocument> | undefined) ??
  mongoose.model<SettingsDocument>('Settings', settingsSchema);
