/**
 * Generates deterministic synthetic geometric-gate fixtures.
 *
 * Renders a handful of scenes with `lib/vision`'s synthetic camera simulator
 * (`renderSyntheticScene`) and writes each one out as a
 * `<name>.png` + `<name>.ground-truth.json` pair, in the exact convention
 * `scripts/geometric-gate.ts` reads (see docs/testing/geometric-gate-guide.md
 * §4-5). This exists so the harness can be exercised end-to-end — with real,
 * non-trivial pass/fail numbers — without waiting on the user's real table
 * photos, which is a separate, still-pending step (plan Phase 5).
 *
 * These are NOT a substitute for the real-photo geometric gate — see the
 * "What it is NOT" note in `lib/vision/synthetic.ts`. Passing here proves the
 * harness plumbing (decode → recognize → compare → report) is correct; it
 * does not certify real-world accuracy.
 *
 * Usage: npx tsx scripts/generate-synthetic-fixtures.ts [output-dir]
 *   (defaults to scripts/fixtures)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodePng, renderSyntheticScene, SYNTHETIC_BALL_RGB } from '@/lib/vision';
import type { SyntheticSceneSpec } from '@/lib/vision';
import type { BallColor, TableSize } from '@/lib/types';

const DEFAULT_OUTPUT_DIR = 'scripts/fixtures';

/** Balls are listed white/yellow/red/red so ground truth can label them
 * white/yellow/red1/red2 by position in this array — see the note on
 * red1/red2 in `scripts/geometric-gate.ts` for why that labeling is
 * arbitrary-but-fine (the harness doesn't trust red1-vs-red2 identity). */
const BALL_ORDER: BallColor[] = ['white', 'yellow', 'red1', 'red2'];

interface Scene {
  name: string;
  tableSize: TableSize;
  spec: Omit<SyntheticSceneSpec, 'tableSize'>;
}

const SCENES: Scene[] = [
  {
    // Standing behind a short rail, phone at chest height — the "typical
    // upload" angle the whole pipeline is designed around.
    name: 'synthetic-001-short-rail',
    tableSize: '대대',
    spec: {
      imageWidth: 1280,
      imageHeight: 960,
      camera: { positionMm: { x: -1250, y: 635, z: 1500 }, lookAtMm: { x: 1270, y: 635 }, focalPx: 1050 },
      balls: [
        { positionMm: { x: 700, y: 300 }, rgb: SYNTHETIC_BALL_RGB.white },
        { positionMm: { x: 1900, y: 950 }, rgb: SYNTHETIC_BALL_RGB.yellow },
        { positionMm: { x: 1300, y: 600 }, rgb: SYNTHETIC_BALL_RGB.red },
        { positionMm: { x: 2100, y: 300 }, rgb: SYNTHETIC_BALL_RGB.red },
      ],
      seed: 1,
    },
  },
  {
    // Standing along a long side instead, closer and lower — different
    // homography, different foreshortening.
    name: 'synthetic-002-long-side',
    tableSize: '대대',
    spec: {
      imageWidth: 1280,
      imageHeight: 960,
      camera: { positionMm: { x: 1270, y: -900, z: 1200 }, lookAtMm: { x: 1270, y: 635 }, focalPx: 1000 },
      balls: [
        { positionMm: { x: 1270, y: 900 }, rgb: SYNTHETIC_BALL_RGB.white },
        { positionMm: { x: 600, y: 400 }, rgb: SYNTHETIC_BALL_RGB.yellow },
        { positionMm: { x: 1800, y: 700 }, rgb: SYNTHETIC_BALL_RGB.red },
        { positionMm: { x: 1000, y: 1000 }, rgb: SYNTHETIC_BALL_RGB.red },
      ],
      seed: 2,
    },
  },
  {
    // Off-corner oblique angle, camera raised higher — stresses the pose
    // recovery differently again, balls placed close to the cushions.
    name: 'synthetic-003-corner-high',
    tableSize: '대대',
    spec: {
      imageWidth: 1280,
      imageHeight: 960,
      camera: { positionMm: { x: -800, y: -700, z: 1800 }, lookAtMm: { x: 1500, y: 700 }, focalPx: 1150 },
      balls: [
        { positionMm: { x: 300, y: 200 }, rgb: SYNTHETIC_BALL_RGB.white },
        { positionMm: { x: 2200, y: 1000 }, rgb: SYNTHETIC_BALL_RGB.yellow },
        { positionMm: { x: 1270, y: 635 }, rgb: SYNTHETIC_BALL_RGB.red },
        { positionMm: { x: 1800, y: 300 }, rgb: SYNTHETIC_BALL_RGB.red },
      ],
      seed: 3,
    },
  },
  {
    // 중대 preset instead of 대대 — different dimensions entirely, to make
    // sure the harness doesn't have a 대대-shaped assumption baked in.
    name: 'synthetic-004-jungdae',
    tableSize: '중대',
    spec: {
      imageWidth: 1280,
      imageHeight: 960,
      camera: { positionMm: { x: -1150, y: 610, z: 1400 }, lookAtMm: { x: 1200, y: 610 }, focalPx: 1080 },
      balls: [
        { positionMm: { x: 500, y: 900 }, rgb: SYNTHETIC_BALL_RGB.white },
        { positionMm: { x: 2000, y: 300 }, rgb: SYNTHETIC_BALL_RGB.yellow },
        { positionMm: { x: 1200, y: 600 }, rgb: SYNTHETIC_BALL_RGB.red },
        { positionMm: { x: 1700, y: 900 }, rgb: SYNTHETIC_BALL_RGB.red },
      ],
      seed: 4,
    },
  },
  {
    // Steeper downward angle (camera roughly overhead-ish but still
    // oblique, not top-down) — a fifth, distinct pose/layout combination.
    name: 'synthetic-005-steep',
    tableSize: '대대',
    spec: {
      imageWidth: 1280,
      imageHeight: 960,
      // Original (400, 300, 2200) put the camera inside the table footprint
      // (0..2540 x 0..1219), so the near cushion was physically behind it and
      // correctly unrecoverable — not a pipeline bug. Moved outside the
      // footprint (per worker-2) while keeping the steep downward angle.
      camera: { positionMm: { x: -700, y: -600, z: 2400 }, lookAtMm: { x: 1270, y: 635 }, focalPx: 1300 },
      balls: [
        { positionMm: { x: 900, y: 1000 }, rgb: SYNTHETIC_BALL_RGB.white },
        { positionMm: { x: 1900, y: 200 }, rgb: SYNTHETIC_BALL_RGB.yellow },
        { positionMm: { x: 500, y: 300 }, rgb: SYNTHETIC_BALL_RGB.red },
        { positionMm: { x: 2300, y: 900 }, rgb: SYNTHETIC_BALL_RGB.red },
      ],
      seed: 5,
    },
  },
];

async function main(): Promise<void> {
  const outputDir = process.argv[2] ?? DEFAULT_OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });

  for (const scene of SCENES) {
    const rendered = renderSyntheticScene({ ...scene.spec, tableSize: scene.tableSize });
    const png = await encodePng(rendered.image);

    const photoFile = `${scene.name}.png`;
    await writeFile(path.join(outputDir, photoFile), png);

    const groundTruth = {
      photoFile,
      table: {
        size: scene.tableSize,
        widthMm: rendered.tableCornersMm[1].x, // {0,0}-{W,0}-{W,H}-{0,H} — corner 1 is (W,0)
        heightMm: rendered.tableCornersMm[2].y, // corner 2 is (W,H)
      },
      balls: BALL_ORDER.map((color, i) => ({
        color,
        x: rendered.ballPositionsMm[i].x,
        y: rendered.ballPositionsMm[i].y,
      })),
    };
    await writeFile(
      path.join(outputDir, `${scene.name}.ground-truth.json`),
      JSON.stringify(groundTruth, null, 2)
    );

    console.log(`✓ wrote ${photoFile} + ground truth (${scene.tableSize}, seed ${scene.spec.seed})`);
  }

  console.log(`\n${SCENES.length} synthetic fixture(s) written to "${outputDir}".`);
}

main().catch((err) => {
  console.error('generate-synthetic-fixtures: failed —', err);
  process.exit(1);
});
