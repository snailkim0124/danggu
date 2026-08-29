import { describe, expect, it } from 'vitest';
import { classifyBallColors, colorFeatures } from './balls';

/**
 * Colour classification must survive lighting changes, because the failure it
 * guards against is the worst one in the product: swapping white and yellow
 * silently reassigns the cue ball, which makes 100% of the shot
 * recommendations wrong while the diagram still looks completely normal
 * (plan Risk "인접 테이블/색상 오분류로 큐볼 스왑").
 *
 * Plan verification step: "흰/노랑 분류가 다양한 조명 샘플에서 상대색상 기준으로
 * 안정적인지 확인".
 */

type Rgb = [number, number, number];

/** Reference ball colours under neutral light. */
const NEUTRAL = {
  white: [236, 233, 224] as Rgb,
  yellow: [226, 186, 38] as Rgb,
  red: [182, 38, 34] as Rgb,
};

/**
 * Apply a lighting model: per-channel gain (colour temperature) plus overall
 * exposure. This is what a different hall does to every ball at once — and
 * why absolute thresholds cannot work.
 */
function relight(rgb: Rgb, gain: Rgb, exposure: number): Rgb {
  return [
    Math.min(255, rgb[0] * gain[0] * exposure),
    Math.min(255, rgb[1] * gain[1] * exposure),
    Math.min(255, rgb[2] * gain[2] * exposure),
  ];
}

const LIGHTING: Array<[string, Rgb, number]> = [
  ['neutral daylight', [1, 1, 1], 1],
  ['warm tungsten', [1.18, 1.0, 0.72], 0.95],
  ['very warm / dim hall', [1.25, 0.98, 0.62], 0.72],
  ['cool LED', [0.9, 1.0, 1.15], 1.05],
  ['bright overexposed', [1.05, 1.02, 0.98], 1.35],
  ['dim underexposed', [1, 1, 1], 0.45],
];

function assignmentColors(rgbs: Rgb[]): Record<string, number> {
  return classifyBallColors(rgbs).indices;
}

describe('classifyBallColors', () => {
  it.each(LIGHTING)('classifies all four balls under %s', (_label, gain, exposure) => {
    const rgbs: Rgb[] = [
      relight(NEUTRAL.white, gain, exposure),
      relight(NEUTRAL.yellow, gain, exposure),
      relight(NEUTRAL.red, gain, exposure),
      relight(NEUTRAL.red, gain, exposure),
    ];
    const idx = assignmentColors(rgbs);
    expect(idx.white).toBe(0);
    expect(idx.yellow).toBe(1);
    expect([idx.red1, idx.red2].sort()).toEqual([2, 3]);
  });

  it('is invariant to the order the balls were detected in', () => {
    const base: Rgb[] = [NEUTRAL.white, NEUTRAL.yellow, NEUTRAL.red, NEUTRAL.red];
    // Every permutation must recover the same physical assignment.
    const permutations = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ];
    for (const perm of permutations) {
      const rgbs = perm.map((i) => base[i]) as Rgb[];
      const idx = assignmentColors(rgbs);
      expect(perm[idx.white]).toBe(0);
      expect(perm[idx.yellow]).toBe(1);
      expect([perm[idx.red1], perm[idx.red2]].sort()).toEqual([2, 3]);
    }
  });

  it('separates white from yellow relatively, even when warm light makes white look yellow', () => {
    // Under strong tungsten a *white* ball's raw RGB is more yellow than a
    // *yellow* ball's under cool light. Any absolute hue/threshold rule breaks
    // here; the relative comparison must not.
    const warmWhite = relight(NEUTRAL.white, [1.3, 1.02, 0.55], 0.9);
    const coolYellow = relight(NEUTRAL.yellow, [0.88, 1.0, 1.2], 1.0);
    // Sanity: the warm white really is bluer-deficient than a neutral white.
    expect(colorFeatures(warmWhite).blueShare).toBeLessThan(
      colorFeatures(NEUTRAL.white).blueShare
    );

    // Both balls are in the same photo, so both see the same light.
    const gain: Rgb = [1.3, 1.02, 0.55];
    const rgbs: Rgb[] = [
      relight(NEUTRAL.white, gain, 0.9),
      relight(NEUTRAL.yellow, gain, 0.9),
      relight(NEUTRAL.red, gain, 0.9),
      relight(NEUTRAL.red, gain, 0.9),
    ];
    const idx = assignmentColors(rgbs);
    expect(idx.white).toBe(0);
    expect(idx.yellow).toBe(1);
    void coolYellow;
  });

  it('reports a high margin when the four balls are clearly distinct', () => {
    const result = classifyBallColors([
      NEUTRAL.white,
      NEUTRAL.yellow,
      NEUTRAL.red,
      NEUTRAL.red,
    ]);
    expect(result.margin).toBeGreaterThan(0.5);
  });

  it('reports a low margin when two balls are nearly the same colour', () => {
    // A yellow ball so desaturated it could plausibly be the white one — the
    // ambiguous case that must route the user to manual correction rather
    // than being resolved with false confidence.
    const ambiguous = classifyBallColors([
      [232, 230, 222],
      [231, 226, 208],
      NEUTRAL.red,
      NEUTRAL.red,
    ]);
    const clear = classifyBallColors([
      NEUTRAL.white,
      NEUTRAL.yellow,
      NEUTRAL.red,
      NEUTRAL.red,
    ]);
    expect(ambiguous.margin).toBeLessThan(clear.margin);
  });

  it('rejects a ball count other than four', () => {
    expect(() => classifyBallColors([NEUTRAL.white, NEUTRAL.yellow, NEUTRAL.red])).toThrow(
      /expected exactly 4/
    );
  });

  it('always produces four distinct indices', () => {
    for (const [, gain, exposure] of LIGHTING) {
      const idx = assignmentColors([
        relight(NEUTRAL.white, gain, exposure),
        relight(NEUTRAL.yellow, gain, exposure),
        relight(NEUTRAL.red, gain, exposure),
        relight(NEUTRAL.red, gain, exposure),
      ]);
      expect(new Set([idx.white, idx.yellow, idx.red1, idx.red2]).size).toBe(4);
    }
  });
});

describe('colorFeatures', () => {
  it('gives a neutral ball a blueShare near one third and near-zero chroma', () => {
    const f = colorFeatures([200, 200, 200]);
    expect(f.blueShare).toBeCloseTo(1 / 3, 3);
    expect(f.chroma).toBeCloseTo(0, 6);
  });

  it('gives yellow a markedly lower blueShare than white', () => {
    expect(colorFeatures(NEUTRAL.yellow).blueShare).toBeLessThan(
      colorFeatures(NEUTRAL.white).blueShare - 0.1
    );
  });

  it('is invariant to exposure — features compare colour, not brightness', () => {
    const bright = colorFeatures(NEUTRAL.yellow);
    const dim = colorFeatures(relight(NEUTRAL.yellow, [1, 1, 1], 0.5));
    expect(dim.blueShare).toBeCloseTo(bright.blueShare, 2);
    expect(dim.hue).toBeCloseTo(bright.hue, 0);
  });
});
