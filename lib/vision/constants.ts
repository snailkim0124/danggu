/**
 * Physical + tuning constants for the Vision Recognition module.
 *
 * Anything that is a *measured physical fact* lives here with a source note.
 * Anything that is a *tuning knob* is also exposed through `RecognizeOptions`
 * (see `pipeline.ts`) so callers and the geometric-gate harness can sweep it
 * without editing this file.
 */

/**
 * Korean 4구(사구) carom ball: 65.5mm diameter (international carom is
 * 61.5mm). Matches `lib/pathcalc/config.ts`'s `BALL_DIAMETER_MM` — the two
 * modules were previously out of sync (this one used the international
 * spec), which meant the z=ball-radius parallax correction here and the
 * cushion/contact geometry in Path Calculation were silently assuming
 * slightly different ball sizes. Kept as separate constants per module
 * (rather than one shared import) since Vision and Path Calculation are
 * independent modules by design, but the *value* must stay identical.
 *
 * Overridable per call via `RecognizeOptions.ballRadiusMm` if the user's
 * house balls turn out to be a different size.
 */
export const BALL_DIAMETER_MM = 65.5;

/** Ball radius in mm — the height of a resting ball's centre above the cloth. */
export const BALL_RADIUS_MM = BALL_DIAMETER_MM / 2;

/**
 * Max image dimension after downscale. Vercel serverless functions have hard
 * execution-time/memory limits and OpenCV.js (WASM) is materially slower than
 * a native build, so every pipeline run downscales first.
 * See plan Risk "Vercel 서버리스 함수 실행시간/메모리 제한".
 */
export const MAX_IMAGE_DIMENSION = 1600;

/**
 * Confidence at or above which the result is trusted enough to skip the
 * manual-correction screen. Below this, `needsManualCorrection` is set and the
 * UI must branch to the photo-overlay correction step
 * (plan "인식 확인 화면 분리").
 *
 * Chosen conservatively: a silent cue-ball colour swap makes 100% of the
 * downstream recommendations wrong while looking completely normal, so the
 * cost of a false "confident" is far higher than the cost of an extra
 * confirmation tap.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Plausible range for the camera's height above the cloth, in mm. Used as a
 * sanity check on the recovered pose: a phone held by a standing player is
 * roughly 1.2-1.8m up, a phone resting on the rail is ~0.1m. Anything outside
 * this band means the focal-length estimate or the table quad is wrong.
 */
export const PLAUSIBLE_CAMERA_HEIGHT_MM = { min: 80, max: 4000 } as const;
