/**
 * Geometric gate test harness (plan Phase 5, "지오메트릭 게이트").
 *
 * Measures Vision Recognition accuracy only — it never touches a cue stick.
 * See `docs/testing/geometric-gate-guide.md` for how to collect the photo +
 * ground-truth pairs this script reads, and the exact ground-truth JSON
 * shape (kept in sync with the `GroundTruth` type below — if you change one,
 * change the other). See `docs/testing/play-gate-checklist.md` for the
 * separate, human-executed gate that measures actual shot success.
 *
 * Usage:
 *   npx tsx scripts/geometric-gate.ts [test-cases-dir] [--threshold=8]
 *
 *   test-cases-dir   Directory of `<name>.<jpg|jpeg|png|webp>` +
 *                     `<name>.ground-truth.json` pairs. Defaults to
 *                     `test-data/geometric-gate` (the path suggested in the
 *                     guide) when omitted.
 *   --threshold=N    Pass/fail RMS threshold in mm. Defaults to 8, the
 *                     example figure in the plan's Phase 5.
 *
 * Exit code: 0 when every discovered case was processed without error and
 * the pooled RMS is within the threshold (this also covers the "no fixtures
 * yet" case — see §3 below), 1 otherwise.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeImage, recognize } from '@/lib/vision';
import type { Ball, BallColor, Point, Settings, TableSize } from '@/lib/types';
import { TABLE_DIMENSIONS_MM } from '@/lib/types';

const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const GROUND_TRUTH_SUFFIX = '.ground-truth.json';
const DEFAULT_TEST_CASES_DIR = 'test-data/geometric-gate';
const DEFAULT_THRESHOLD_MM = 8;
const REQUIRED_COLORS: BallColor[] = ['white', 'yellow', 'red1', 'red2'];

// ---------------------------------------------------------------------------
// Ground truth shape — matches docs/testing/geometric-gate-guide.md §5.
// ---------------------------------------------------------------------------

interface GroundTruthBall {
  color: BallColor;
  x: number;
  y: number;
}

interface GroundTruth {
  photoFile: string;
  table: { size: TableSize; widthMm: number; heightMm: number };
  balls: GroundTruthBall[];
}

function isTableSize(value: unknown): value is TableSize {
  return value === '대대' || value === '중대';
}

function isBallColor(value: unknown): value is BallColor {
  return value === 'white' || value === 'yellow' || value === 'red1' || value === 'red2';
}

/** Throws a descriptive error rather than returning false — a malformed
 * ground-truth file should name itself and the exact problem, not just fail
 * a boolean check the caller has to re-diagnose. */
function parseGroundTruth(raw: unknown, sourceFile: string): GroundTruth {
  const fail = (msg: string): never => {
    throw new Error(`${sourceFile}: ${msg}`);
  };

  if (typeof raw !== 'object' || raw === null) fail('top-level value must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.photoFile !== 'string') fail('"photoFile" must be a string');

  const tableRaw = obj.table as Record<string, unknown> | undefined;
  if (typeof tableRaw !== 'object' || tableRaw === null) fail('"table" must be an object');
  // `fail` always throws, so runtime-wise `tableRaw` is guaranteed a non-null
  // object past this point — but TS's control-flow analysis doesn't narrow
  // through a bare call to a `never`-returning function used as a statement,
  // so re-bind explicitly rather than keep reading the still-widened `tableRaw`.
  const table = tableRaw as Record<string, unknown>;
  if (!isTableSize(table.size)) fail(`"table.size" must be '대대' or '중대', got ${JSON.stringify(table.size)}`);
  if (typeof table.widthMm !== 'number' || !Number.isFinite(table.widthMm) || table.widthMm <= 0) {
    fail('"table.widthMm" must be a positive finite number');
  }
  if (typeof table.heightMm !== 'number' || !Number.isFinite(table.heightMm) || table.heightMm <= 0) {
    fail('"table.heightMm" must be a positive finite number');
  }

  if (!Array.isArray(obj.balls)) fail('"balls" must be an array');
  const balls: GroundTruthBall[] = [];
  for (const [i, entry] of (obj.balls as unknown[]).entries()) {
    const b = entry as Record<string, unknown>;
    if (!isBallColor(b?.color)) fail(`balls[${i}].color must be one of ${REQUIRED_COLORS.join(', ')}`);
    if (typeof b.x !== 'number' || !Number.isFinite(b.x)) fail(`balls[${i}].x must be a finite number`);
    if (typeof b.y !== 'number' || !Number.isFinite(b.y)) fail(`balls[${i}].y must be a finite number`);
    balls.push({ color: b.color as BallColor, x: b.x as number, y: b.y as number });
  }

  const seenColors = new Set(balls.map((b) => b.color));
  const missing = REQUIRED_COLORS.filter((c) => !seenColors.has(c));
  if (missing.length > 0) fail(`"balls" is missing entries for: ${missing.join(', ')}`);
  if (balls.length !== REQUIRED_COLORS.length) {
    fail(`"balls" must have exactly ${REQUIRED_COLORS.length} entries (one per color), got ${balls.length}`);
  }

  return {
    photoFile: obj.photoFile as string,
    table: { size: table.size as TableSize, widthMm: table.widthMm as number, heightMm: table.heightMm as number },
    balls,
  };
}

// ---------------------------------------------------------------------------
// Coordinate-frame alignment
//
// `recognize()`'s output places balls in a table-mm frame whose origin is
// whichever image corner the pipeline's line-fitting internally calls
// "first" — that is an implementation detail of `lib/vision`, not a
// documented contract, so it isn't necessarily the same physical corner the
// user measured ground truth from (see docs/testing/geometric-gate-guide.md
// §5's "확인 필요" note). Both frames DO agree on which axis is which
// (x runs along the table's long/width side, y along the short/height side —
// `tableRectMm`/`rectifiedBoundary` in lib/vision fix that), so the only
// remaining ambiguity is a possible mirror flip of either axis. Rather than
// hard-coding an assumption that will silently produce inflated error
// figures if wrong, try all 4 axis-preserving symmetries of the rectangle
// and score against the best fit — logging when a non-identity transform was
// needed, since that is itself useful signal that the reference corner
// convention should be revisited.
// ---------------------------------------------------------------------------

type Transform = (p: { x: number; y: number }, widthMm: number, heightMm: number) => { x: number; y: number };

const TRANSFORMS: Record<string, Transform> = {
  identity: (p) => ({ x: p.x, y: p.y }),
  mirrorX: (p, w) => ({ x: w - p.x, y: p.y }),
  mirrorY: (p, _w, h) => ({ x: p.x, y: h - p.y }),
  mirrorXY: (p, w, h) => ({ x: w - p.x, y: h - p.y }),
};

function rms(errorsMm: number[]): number {
  if (errorsMm.length === 0) return 0;
  const meanSquare = errorsMm.reduce((sum, e) => sum + e * e, 0) / errorsMm.length;
  return Math.sqrt(meanSquare);
}

interface CaseResult {
  photoFile: string;
  perBallErrorMm: Partial<Record<BallColor, number>>;
  transformUsed: string;
  rmsMm: number;
  confidence: number;
  needsManualCorrection: boolean;
}

const DIRECT_MATCH_COLORS: BallColor[] = ['white', 'yellow'];
const RED_COLORS: BallColor[] = ['red1', 'red2'];

/** Applies each candidate transform to the ground-truth points and returns
 * the transform with the lowest RMS along with its per-ball errors.
 *
 * White/yellow are matched by color id directly (they're classified by
 * relative color and so carry real identity). Red1/red2 are NOT — both are
 * the same physical red ball color, so which detected blob the pipeline
 * happens to label "red1" vs "red2" is arbitrary and unrelated to which
 * label the ground truth used. Matching those by id would silently inflate
 * RMS whenever the pipeline's arbitrary choice disagrees with the ground
 * truth's arbitrary choice, on cases where the detector was actually
 * perfect. Instead, try both possible red1/red2 pairings and keep whichever
 * pairing is cheaper. */
function bestAlignment(
  groundTruth: GroundTruth,
  detectedBalls: Ball[]
): { transformName: string; perBallErrorMm: Partial<Record<BallColor, number>>; rmsMm: number } {
  const detectedByColor = new Map(detectedBalls.map((b) => [b.color, b.position]));
  const groundTruthByColor = new Map(groundTruth.balls.map((b) => [b.color, { x: b.x, y: b.y }]));

  let best: { transformName: string; perBallErrorMm: Partial<Record<BallColor, number>>; rmsMm: number } | null =
    null;

  for (const [name, transform] of Object.entries(TRANSFORMS)) {
    const perBallErrorMm: Partial<Record<BallColor, number>> = {};
    const errors: number[] = [];

    for (const color of DIRECT_MATCH_COLORS) {
      const groundTruthPoint = groundTruthByColor.get(color);
      const detected = detectedByColor.get(color);
      if (!groundTruthPoint || !detected) continue; // missing detection — scored separately by the caller
      const transformed = transform(groundTruthPoint, groundTruth.table.widthMm, groundTruth.table.heightMm);
      const error = Math.hypot(transformed.x - detected.x, transformed.y - detected.y);
      perBallErrorMm[color] = error;
      errors.push(error);
    }

    const groundTruthReds = RED_COLORS.map((c) => groundTruthByColor.get(c));
    const detectedReds = RED_COLORS.map((c) => detectedByColor.get(c));
    if (groundTruthReds.every((p): p is { x: number; y: number } => !!p) && detectedReds.every((p): p is Point => !!p)) {
      const transformedReds = groundTruthReds.map((p) =>
        transform(p, groundTruth.table.widthMm, groundTruth.table.heightMm)
      );
      const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
      const straight = [dist(transformedReds[0], detectedReds[0]), dist(transformedReds[1], detectedReds[1])];
      const swapped = [dist(transformedReds[0], detectedReds[1]), dist(transformedReds[1], detectedReds[0])];
      const chosen = straight[0] + straight[1] <= swapped[0] + swapped[1] ? straight : swapped;
      perBallErrorMm[RED_COLORS[0]] = chosen[0];
      perBallErrorMm[RED_COLORS[1]] = chosen[1];
      errors.push(...chosen);
    }

    const candidateRms = rms(errors);
    if (!best || candidateRms < best.rmsMm) {
      best = { transformName: name, perBallErrorMm, rmsMm: candidateRms };
    }
  }

  // Only reachable if groundTruth.balls is empty, which parseGroundTruth
  // already rejects — but keep the type checker (and future refactors) honest.
  if (!best) throw new Error('bestAlignment: no candidate transform produced a result');
  return best;
}

// ---------------------------------------------------------------------------
// Test case discovery
// ---------------------------------------------------------------------------

interface TestCasePaths {
  name: string;
  photoPath: string;
  groundTruthPath: string;
}

async function discoverTestCases(dir: string): Promise<TestCasePaths[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const groundTruthFiles = entries.filter((f) => f.endsWith(GROUND_TRUTH_SUFFIX));

  const cases: TestCasePaths[] = [];
  for (const gtFile of groundTruthFiles) {
    const name = gtFile.slice(0, -GROUND_TRUTH_SUFFIX.length);
    const photoFile = PHOTO_EXTENSIONS.map((ext) => `${name}${ext}`).find((candidate) =>
      entries.includes(candidate)
    );
    if (!photoFile) {
      console.warn(
        `⚠ Skipping "${gtFile}": no matching photo found (expected "${name}" + one of ${PHOTO_EXTENSIONS.join(', ')})`
      );
      continue;
    }
    cases.push({ name, photoPath: path.join(dir, photoFile), groundTruthPath: path.join(dir, gtFile) });
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { testCasesDir: string; thresholdMm: number } {
  let testCasesDir = DEFAULT_TEST_CASES_DIR;
  let thresholdMm = DEFAULT_THRESHOLD_MM;

  for (const arg of argv) {
    if (arg.startsWith('--threshold=')) {
      const value = Number(arg.slice('--threshold='.length));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--threshold must be a positive number, got "${arg}"`);
      }
      thresholdMm = value;
    } else if (!arg.startsWith('--')) {
      testCasesDir = arg;
    } else {
      throw new Error(`Unrecognized flag: ${arg}`);
    }
  }

  return { testCasesDir, thresholdMm };
}

async function main(): Promise<number> {
  const { testCasesDir, thresholdMm } = parseArgs(process.argv.slice(2));

  console.log(`지오메트릭 게이트 — test cases: "${testCasesDir}", threshold: ${thresholdMm}mm RMS\n`);

  const testCases = await discoverTestCases(testCasesDir);

  if (testCases.length === 0) {
    console.log(
      `0/0 processed — no photo + ground-truth pairs found in "${testCasesDir}".\n` +
        'This is expected until fixtures are collected (see docs/testing/geometric-gate-guide.md). ' +
        'Nothing to fail here, so exiting cleanly.'
    );
    return 0;
  }

  const results: CaseResult[] = [];
  const failures: { name: string; error: string }[] = [];

  for (const testCase of testCases) {
    try {
      const [photoBytes, groundTruthRaw] = await Promise.all([
        readFile(testCase.photoPath),
        readFile(testCase.groundTruthPath, 'utf8'),
      ]);
      const groundTruth = parseGroundTruth(JSON.parse(groundTruthRaw), testCase.groundTruthPath);

      if (
        Math.abs(groundTruth.table.widthMm - TABLE_DIMENSIONS_MM[groundTruth.table.size].widthMm) > 5 ||
        Math.abs(groundTruth.table.heightMm - TABLE_DIMENSIONS_MM[groundTruth.table.size].heightMm) > 5
      ) {
        console.warn(
          `⚠ ${testCase.name}: ground-truth table dims (${groundTruth.table.widthMm}x${groundTruth.table.heightMm}mm) ` +
            `differ from the ${groundTruth.table.size} preset (${TABLE_DIMENSIONS_MM[groundTruth.table.size].widthMm}x` +
            `${TABLE_DIMENSIONS_MM[groundTruth.table.size].heightMm}mm) by more than 5mm — using the measured dims for ` +
            'this case, but double-check the ruler measurement in the guide.'
        );
      }

      const image = await decodeImage(new Uint8Array(photoBytes));
      // cueBallColor only affects role labeling, not the position each ball
      // is detected at, so a fixed value is fine for a position-accuracy gate.
      const settings: Settings = { cueBallColor: 'white', tableSize: groundTruth.table.size };
      const { recognition } = await recognize(image, settings);

      const { transformName, perBallErrorMm, rmsMm } = bestAlignment(groundTruth, recognition.balls);
      const missingColors = REQUIRED_COLORS.filter((c) => !(c in perBallErrorMm));
      if (missingColors.length > 0) {
        throw new Error(
          `recognize() did not return a position for: ${missingColors.join(', ')} ` +
            '(should be unreachable — recognize() throws when fewer than 4 balls are found)'
        );
      }

      results.push({
        photoFile: testCase.name,
        perBallErrorMm,
        transformUsed: transformName,
        rmsMm,
        confidence: recognition.confidence,
        needsManualCorrection: recognition.needsManualCorrection,
      });

      const flag = transformName !== 'identity' ? ` [needed ${transformName} — check reference corner]` : '';
      console.log(`✓ ${testCase.name}: RMS ${rmsMm.toFixed(1)}mm${flag}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ name: testCase.name, error: message });
      console.log(`✗ ${testCase.name}: ERROR — ${message}`);
    }
  }

  const pooledErrors = results.flatMap((r) => Object.values(r.perBallErrorMm) as number[]);
  const overallRms = rms(pooledErrors);
  const nonIdentityCount = results.filter((r) => r.transformUsed !== 'identity').length;

  console.log('\n--- 지오메트릭 게이트 리포트 ---');
  console.log(`Cases found:      ${testCases.length}`);
  console.log(`Processed OK:     ${results.length}`);
  console.log(`Errored:          ${failures.length}`);
  console.log(`Pooled ball RMS:  ${overallRms.toFixed(2)}mm (threshold: ${thresholdMm}mm)`);
  if (nonIdentityCount > 0) {
    console.log(
      `⚠ ${nonIdentityCount}/${results.length} case(s) needed a mirrored alignment to match ground truth — ` +
        'this usually means the reference-corner convention in the ground-truth data does not match the ' +
        'pipeline\'s output frame. Worth confirming before trusting the RMS figure above.'
    );
  }

  if (failures.length > 0) {
    console.log('\nErrored cases (excluded from RMS, counted as gate failures):');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }

  const worstFirst = [...results].sort((a, b) => b.rmsMm - a.rmsMm).slice(0, 5);
  if (worstFirst.length > 0) {
    console.log('\nWorst cases (top 5, for failure-pattern analysis):');
    for (const r of worstFirst) {
      console.log(
        `  - ${r.photoFile}: RMS ${r.rmsMm.toFixed(1)}mm, confidence ${r.confidence.toFixed(2)}` +
          (r.needsManualCorrection ? ' [needsManualCorrection]' : '')
      );
    }
  }

  const rmsOk = overallRms <= thresholdMm;
  const passed = failures.length === 0 && rmsOk;

  let verdictReason: string;
  if (passed) {
    verdictReason = `within ${thresholdMm}mm RMS threshold`;
  } else if (failures.length > 0 && !rmsOk) {
    verdictReason = `${failures.length} case(s) errored AND pooled RMS exceeds ${thresholdMm}mm threshold`;
  } else if (failures.length > 0) {
    verdictReason = `${failures.length} case(s) errored (pooled RMS of processed cases was within threshold)`;
  } else {
    verdictReason = `pooled RMS exceeds ${thresholdMm}mm threshold`;
  }
  console.log(`\n${passed ? 'PASS ✓' : 'FAIL ✗'} — ${verdictReason}`);

  return passed ? 0 : 1;
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    console.error('geometric-gate: unexpected crash —', err);
    process.exit(1);
  });
