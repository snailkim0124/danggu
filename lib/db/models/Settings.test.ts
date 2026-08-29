import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_SINGLETON_ID, SettingsModel } from '@/lib/db/models/Settings';
import { DEFAULT_SKILL_PROFILE, SKILL_CATEGORIES } from '@/lib/types';

// These tests only exercise schema shape/validation (no DB connection needed —
// `new Model()` + `validate()` never touch the network).
describe('SettingsModel schema', () => {
  it('applies the documented defaults when unset', () => {
    const doc = new SettingsModel();
    expect(doc.cueBallColor).toBe(DEFAULT_SETTINGS.cueBallColor);
    expect(doc.tableSize).toBe(DEFAULT_SETTINGS.tableSize);
    expect(doc._id).toBe(SETTINGS_SINGLETON_ID);
    expect(JSON.parse(JSON.stringify(doc.skillProfile))).toEqual(DEFAULT_SKILL_PROFILE);
  });

  it('accepts a valid enum combination', async () => {
    const doc = new SettingsModel({ cueBallColor: 'yellow', tableSize: '대대' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects an out-of-enum cueBallColor', async () => {
    const doc = new SettingsModel({ cueBallColor: 'blue', tableSize: '대대' });
    await expect(doc.validate()).rejects.toBeDefined();
  });

  it('rejects an out-of-enum tableSize', async () => {
    const doc = new SettingsModel({ cueBallColor: 'white', tableSize: 'small' });
    await expect(doc.validate()).rejects.toBeDefined();
  });

  it('accepts a fully-specified skillProfile', async () => {
    const doc = new SettingsModel({
      cueBallColor: 'white',
      tableSize: '중대',
      skillProfile: { draw: 5, follow: 1, thinCut: 2, spin: 4, bank: 5, multiCushion: 3 },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects an out-of-range skill level', async () => {
    const doc = new SettingsModel({
      cueBallColor: 'white',
      tableSize: '중대',
      skillProfile: { ...DEFAULT_SKILL_PROFILE, bank: 7 },
    });
    await expect(doc.validate()).rejects.toBeDefined();
  });

  it('every skill category has a default level', () => {
    for (const category of SKILL_CATEGORIES) {
      expect(DEFAULT_SKILL_PROFILE[category]).toBe(3);
    }
  });
});
