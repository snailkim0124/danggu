import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route handlers are unit-tested against mocked mongoose/connection layers
// rather than a real MongoDB (in-memory or Atlas) — no network/binary
// dependency, deterministic, and fast. See lib/db/models/Settings.test.ts
// for schema-level validation tests.
const findByIdAndUpdateMock = vi.fn();

vi.mock('@/lib/db/mongo', () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

// NB: `vi.mock` factories are hoisted above the rest of the module, so this
// object is inlined here (and again below, in each test) rather than shared
// via an outer `const` — a reference to one declared after this call would
// hit the temporal dead zone at runtime.
vi.mock('@/lib/db/models/Settings', () => ({
  SETTINGS_SINGLETON_ID: 'default',
  DEFAULT_SETTINGS: {
    cueBallColor: 'white',
    tableSize: '중대',
    skillProfile: { draw: 3, follow: 3, thinCut: 3, spin: 3, bank: 3, multiCushion: 3 },
  },
  SettingsModel: {
    findByIdAndUpdate: (...args: unknown[]) => findByIdAndUpdateMock(...args),
  },
}));

const DEFAULT_SKILL_PROFILE = { draw: 3, follow: 3, thinCut: 3, spin: 3, bank: 3, multiCushion: 3 };

const { GET, POST } = await import('./route');

function leanResult(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function postRequest(body: unknown) {
  return new Request('http://localhost/api/settings', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  findByIdAndUpdateMock.mockReset();
});

describe('GET /api/settings', () => {
  it('returns the default settings, upserting the singleton if it does not exist', async () => {
    findByIdAndUpdateMock.mockReturnValue(
      leanResult({ _id: 'default', cueBallColor: 'white', tableSize: '중대', skillProfile: DEFAULT_SKILL_PROFILE })
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ cueBallColor: 'white', tableSize: '중대', skillProfile: DEFAULT_SKILL_PROFILE });
    expect(findByIdAndUpdateMock).toHaveBeenCalledWith(
      'default',
      { $setOnInsert: { cueBallColor: 'white', tableSize: '중대', skillProfile: DEFAULT_SKILL_PROFILE } },
      { upsert: true, new: true }
    );
  });
});

describe('POST /api/settings', () => {
  it('upserts and returns a valid settings payload', async () => {
    const skillProfile = { ...DEFAULT_SKILL_PROFILE, bank: 5 };
    findByIdAndUpdateMock.mockReturnValue(
      leanResult({ _id: 'default', cueBallColor: 'yellow', tableSize: '대대', skillProfile })
    );

    const response = await POST(postRequest({ cueBallColor: 'yellow', tableSize: '대대', skillProfile }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ cueBallColor: 'yellow', tableSize: '대대', skillProfile });
    expect(findByIdAndUpdateMock).toHaveBeenCalledWith(
      'default',
      { $set: { cueBallColor: 'yellow', tableSize: '대대', skillProfile } },
      { upsert: true, new: true, runValidators: true }
    );
  });

  it('rejects an invalid cueBallColor with 400 and never touches the DB', async () => {
    const response = await POST(
      postRequest({ cueBallColor: 'blue', tableSize: '대대', skillProfile: DEFAULT_SKILL_PROFILE })
    );

    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid tableSize with 400', async () => {
    const response = await POST(
      postRequest({ cueBallColor: 'white', tableSize: 'small', skillProfile: DEFAULT_SKILL_PROFILE })
    );
    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a missing skillProfile with 400', async () => {
    const response = await POST(postRequest({ cueBallColor: 'white', tableSize: '중대' }));
    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range skill level within skillProfile with 400', async () => {
    const response = await POST(
      postRequest({
        cueBallColor: 'white',
        tableSize: '중대',
        skillProfile: { ...DEFAULT_SKILL_PROFILE, draw: 9 },
      })
    );
    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await POST(postRequest('{not valid json'));
    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-object JSON body with 400', async () => {
    const response = await POST(postRequest('"just a string"'));
    expect(response.status).toBe(400);
    expect(findByIdAndUpdateMock).not.toHaveBeenCalled();
  });
});
