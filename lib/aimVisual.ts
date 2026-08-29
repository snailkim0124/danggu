/**
 * Frontend-local helpers for the 당점/두께(aim point / thickness) visual aid
 * (문제점 #2: 각도·두께가 숫자로만 나와 있어 사용자가 감을 잡기 어려움).
 *
 * Not part of `lib/types.ts` — this is display formatting derived from a
 * `Shot`'s `tipOffset`/`aimTarget.thickness`, not part of the shared contract.
 */

/** A thickness fraction expressed the way players actually talk about it —
 * "1/2", "3/4" — rather than a raw percentage. */
export interface ThicknessFraction {
  numerator: number;
  denominator: number;
  /** `"1/2"`, `"3/4"`, or `"얇게"` for anything thinner than 1/8 (a fraction
   * that thin reads as noise, not information, to a player). */
  label: string;
}

const DENOMINATOR = 8;

/**
 * Snap a continuous `0..1` thickness fraction (0 = thinnest edge contact, 1 =
 * full/center contact, per `lib/types.ts`'s `Shot.aimTarget` doc) to the
 * nearest eighth — the resolution players actually aim to ("반두께", "1/4
 * 두께", etc.), not a number with two decimal places nobody can reproduce at
 * the table.
 */
export function formatThicknessFraction(thickness: number): ThicknessFraction {
  const clamped = Math.min(1, Math.max(0, thickness));
  const numerator = Math.round(clamped * DENOMINATOR);
  if (numerator >= DENOMINATOR) {
    return { numerator: DENOMINATOR, denominator: DENOMINATOR, label: '풀(전체)' };
  }
  if (numerator <= 0) {
    // 0 has no meaningful reduced form ("0/1" reads oddly to a player) — show
    // the raw eighths value rather than reducing.
    return { numerator: 0, denominator: DENOMINATOR, label: `0/${DENOMINATOR}` };
  }
  // Reduce to lowest terms for the display label (8ths that are also
  // quarters/halves read as "1/2"/"1/4", not "4/8"/"2/8") — including the
  // thinnest end (1/8 stays 1/8, since gcd(1,8)=1).
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(numerator, DENOMINATOR);
  return { numerator, denominator: DENOMINATOR, label: `${numerator / g}/${DENOMINATOR / g}` };
}

/** A point on the unit disc, `-1..1` on each axis (matches `Shot.tipOffset`'s
 * own convention), for placing the 당점 marker inside an SVG cue-ball circle. */
export interface UnitPoint {
  x: number;
  y: number;
}

/**
 * Map a `Shot.tipOffset` to a position on the cue-ball face for the 당점
 * marker. `vertical` is top(+)/bottom(-) per `lib/pathcalc/config.ts`'s
 * `TipOffset` doc; SVG y grows downward, so it's negated here — a follow
 * (밀어치기, positive vertical, struck above centre) marker draws above
 * centre, matching where the cue tip actually contacts the ball.
 */
export function tipOffsetToUnitPoint(tipOffset: { vertical: number; horizontal: number } | undefined): UnitPoint {
  if (!tipOffset) return { x: 0, y: 0 };
  const x = Math.min(1, Math.max(-1, tipOffset.horizontal)) || 0; // `|| 0` normalizes -0
  const y = -Math.min(1, Math.max(-1, tipOffset.vertical)) || 0;
  return { x, y };
}
