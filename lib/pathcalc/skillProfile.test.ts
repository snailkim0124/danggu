/**
 * Skill-survey personalization tests (문제점 #1: 설문조사 기능).
 *
 * `classifySkillCategory` and `personalizedRank` are unit-tested directly
 * against hand-built `Shot` fixtures (no simulator needed — this is pure
 * classification/ranking logic). A `computeShotPlans` integration test then
 * proves the wiring: a real layout re-ranks when a lopsided skill profile is
 * supplied, and reproduces the unpersonalized default when it isn't.
 */

import { describe, expect, it } from 'vitest';
import type { Shot, SkillProfile } from '@/lib/types';
import { DEFAULT_SKILL_PROFILE } from '@/lib/types';
import { classifySkillCategory, computeShotPlans, personalizedRank, TECHNIQUE_RANK } from './index';
import { OPEN_LAYOUT, WHITE_CUE_SETTINGS } from './fixtures';

/** Minimal `Shot` builder — only the fields `classifySkillCategory`/`personalizedRank` read. */
function shot(overrides: Partial<Shot>): Shot {
  return {
    id: 'test',
    technique: 'direct',
    aimTarget: { thickness: 1 },
    angleDeg: 0,
    forceLevel: 1,
    sequence: [],
    difficultyScore: 0.5,
    ruleValid: true,
    confidence: 1,
    ...overrides,
  };
}

describe('classifySkillCategory', () => {
  it('maps bankShot (쿠션을 먼저 맞추는 뱅크샷/빈쿠션치기) to bank', () => {
    expect(classifySkillCategory(shot({ technique: 'bankShot' }))).toBe('bank');
  });

  it('maps bank2plus to multiCushion', () => {
    expect(classifySkillCategory(shot({ technique: 'bank2plus' }))).toBe('multiCushion');
  });

  it('maps a strong negative-vertical spin shot to draw (끌어치기), regardless of technique', () => {
    expect(
      classifySkillCategory(shot({ technique: 'direct', tipOffset: { vertical: -0.8, horizontal: 0 } })),
    ).toBe('draw');
    expect(
      classifySkillCategory(shot({ technique: 'bank1', tipOffset: { vertical: -0.8, horizontal: 0 } })),
    ).toBe('draw');
  });

  it('maps a strong positive-vertical spin shot to follow (밀어치기), regardless of technique', () => {
    expect(
      classifySkillCategory(shot({ technique: 'direct', tipOffset: { vertical: 0.8, horizontal: 0 } })),
    ).toBe('follow');
  });

  it('maps a mostly-side-spin shot to spin (회전)', () => {
    expect(
      classifySkillCategory(shot({ technique: 'direct', tipOffset: { vertical: 0.1, horizontal: 0.9 } })),
    ).toBe('spin');
  });

  it('bank/multiCushion (technique-level) take priority over a spin tipOffset', () => {
    expect(
      classifySkillCategory(shot({ technique: 'bankShot', tipOffset: { vertical: -0.8, horizontal: 0 } })),
    ).toBe('bank');
    expect(
      classifySkillCategory(shot({ technique: 'bank2plus', tipOffset: { vertical: 0, horizontal: 0.8 } })),
    ).toBe('multiCushion');
  });

  it('maps a thin direct hit with no spin to thinCut (얇게치기)', () => {
    expect(classifySkillCategory(shot({ technique: 'direct', aimTarget: { thickness: 0.15 } }))).toBe(
      'thinCut',
    );
  });

  it('maps a thick/plain direct hit with no spin to no category', () => {
    expect(classifySkillCategory(shot({ technique: 'direct', aimTarget: { thickness: 0.9 } }))).toBeNull();
  });

  it('maps a plain (no-spin) bank1 to no category', () => {
    expect(classifySkillCategory(shot({ technique: 'bank1' }))).toBeNull();
  });
});

describe('personalizedRank', () => {
  const bankShot = shot({ technique: 'bankShot' });
  const direct = shot({ technique: 'direct', aimTarget: { thickness: 0.9 } }); // no category

  it('reduces to the plain TECHNIQUE_RANK when no profile is given', () => {
    expect(personalizedRank(bankShot, undefined)).toBe(TECHNIQUE_RANK.bankShot);
    expect(personalizedRank(direct, undefined)).toBe(TECHNIQUE_RANK.direct);
  });

  it('reduces to the plain TECHNIQUE_RANK for a fully-neutral (all level 3) profile', () => {
    expect(personalizedRank(bankShot, DEFAULT_SKILL_PROFILE)).toBe(TECHNIQUE_RANK.bankShot);
  });

  it('promotes a category rated 5 by a full tier', () => {
    const profile: SkillProfile = { ...DEFAULT_SKILL_PROFILE, bank: 5 };
    expect(personalizedRank(bankShot, profile)).toBe(TECHNIQUE_RANK.bankShot - 1);
  });

  it('demotes a category rated 1 by a full tier', () => {
    const profile: SkillProfile = { ...DEFAULT_SKILL_PROFILE, bank: 1 };
    expect(personalizedRank(bankShot, profile)).toBe(TECHNIQUE_RANK.bankShot + 1);
  });

  it('leaves a shot with no mapped category untouched regardless of the profile', () => {
    const profile: SkillProfile = { ...DEFAULT_SKILL_PROFILE, bank: 5, draw: 1 };
    expect(personalizedRank(direct, profile)).toBe(TECHNIQUE_RANK.direct);
  });
});

describe('computeShotPlans personalization (integration)', () => {
  it('is unaffected by an explicitly-neutral skill profile', () => {
    const settingsNeutral = { ...WHITE_CUE_SETTINGS, skillProfile: DEFAULT_SKILL_PROFILE };
    const withoutProfile = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS).map((p) => p.shot.id);
    const withNeutralProfile = computeShotPlans(OPEN_LAYOUT, settingsNeutral).map((p) => p.shot.id);
    expect(withNeutralProfile).toEqual(withoutProfile);
  });

  it('closes the ranking gap between a non-direct shot and direct via its skill category', () => {
    const baseline = computeShotPlans(OPEN_LAYOUT, WHITE_CUE_SETTINGS);
    // Find a direct candidate whose thickness maps to a skill category, and
    // any non-direct candidate that also maps to one (whichever technique
    // OPEN_LAYOUT actually produces — bank1 itself has no category as of the
    // 뱅크샷/N쿠션 split, so this deliberately doesn't hardcode a technique).
    // enumerateCandidates is deterministic, so if OPEN_LAYOUT stops producing
    // this pairing the test should fail loudly rather than silently no-op.
    const directCandidate = baseline.find(
      (p) => p.shot.technique === 'direct' && classifySkillCategory(p.shot) !== null,
    );
    // Draw/follow/spin now apply regardless of technique, so a same-category
    // collision is possible in principle (e.g. both candidates happen to be
    // 'follow') — require a *different* category so the two profile
    // overrides below can't collide into a single object-literal key.
    const otherCandidate = baseline.find(
      (p) =>
        p.shot.technique !== 'direct' &&
        classifySkillCategory(p.shot) !== null &&
        classifySkillCategory(p.shot) !== classifySkillCategory(directCandidate?.shot ?? p.shot),
    );
    expect(directCandidate).toBeDefined();
    expect(otherCandidate).toBeDefined();
    const directCategory = classifySkillCategory(directCandidate!.shot)!;
    const otherCategory = classifySkillCategory(otherCandidate!.shot)!;

    const skewedProfile: SkillProfile = { ...DEFAULT_SKILL_PROFILE, [otherCategory]: 5, [directCategory]: 1 };
    const personalized = computeShotPlans(OPEN_LAYOUT, { ...WHITE_CUE_SETTINGS, skillProfile: skewedProfile });

    const baselineGap =
      TECHNIQUE_RANK[otherCandidate!.shot.technique] - TECHNIQUE_RANK[directCandidate!.shot.technique];
    const personalizedGap =
      personalizedRank(otherCandidate!.shot, skewedProfile) - personalizedRank(directCandidate!.shot, skewedProfile);
    // A ±1-per-category shift can fully cancel an adjacent-tier gap (1) but
    // only narrow, not necessarily reverse, a wider one (bankShot is 3 tiers
    // from direct) — see `rankShiftForSkillLevel`'s doc. The reliable,
    // tier-gap-independent claim is that it narrows the gap by the full ±1
    // on each side, i.e. by exactly 2.
    expect(personalizedGap).toBe(baselineGap - 2);

    const otherIndex = personalized.findIndex((p) => p.shot.id === otherCandidate!.shot.id);
    const directIndex = personalized.findIndex((p) => p.shot.id === directCandidate!.shot.id);
    // Both may not survive topN thinning depending on how many candidates
    // exist; when they're adjacent tiers (gap 1), the narrowed gap actually
    // crosses zero and `other` should now sort ahead of `direct`.
    if (otherIndex !== -1 && directIndex !== -1 && baselineGap <= 1) {
      expect(otherIndex).toBeLessThan(directIndex);
    } else {
      expect(otherIndex).not.toBe(-1);
    }
  });
});
