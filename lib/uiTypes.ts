/**
 * Frontend-local additive types for the UI layer (components/, app/).
 *
 * These are NOT part of the shared contract in `lib/types.ts` — do not move
 * them there. `/api/path-calc` is a route this frontend work added (see
 * app/api/path-calc/route.ts); its request/response envelope isn't defined
 * anywhere else, so it lives here.
 */

import type { Point, RecognitionResult, Shot } from './types';
import type { PixelDetection } from './vision';

export type { PixelDetection } from './vision';

/**
 * `PixelDetection` (lib/vision) tagged as client-synthesized rather than a
 * real vision-model detection — produced only by
 * `lib/mockData.ts#approximatePixelDetection` when `/api/recognize` hasn't
 * run (e.g. the "샘플 데이터로 계속 진행" fallback in PhotoUpload). The confirm
 * screen shows a lower-confidence notice when this flag is set.
 */
export interface ApproximatePixelDetection extends PixelDetection {
  approximate: true;
}

/** POST body for `/api/path-calc` — the confirmed (possibly user-corrected) recognition result. */
export interface PathCalcRequest {
  recognition: RecognitionResult;
}

/**
 * One ranked shot candidate plus its cue-ball path polyline.
 *
 * `Shot` (lib/types.ts) deliberately carries no path/waypoint field — the
 * route geometry comes from `lib/pathcalc`'s `ShotPlan.path` instead (see
 * lib/pathcalc/candidates.ts). Kept as a pair here rather than widening the
 * shared contract.
 */
export interface PathCalcShotResult {
  shot: Shot;
  /** Cue-ball centre polyline in mm space, including cushion bounce points. */
  path: Point[];
}

/** Response body for `/api/path-calc`. */
export interface PathCalcResponse {
  /** Up to 3 candidates, already sorted (technique primary, difficultyScore
   * tie-break) by the server — the frontend must not re-sort these. */
  shots: PathCalcShotResult[];
  /**
   * True when no `ruleValid` candidate existed and `shots` contains a single
   * closest-miss reference shot instead of a normal recommendation (see plan
   * "유효 후보 0개 시 근접 샷 fallback"). The UI must present this distinctly.
   */
  fallback: boolean;
}
