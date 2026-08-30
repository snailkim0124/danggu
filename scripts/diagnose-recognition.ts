/**
 * Step-by-step Vision Recognition diagnostic for a single real photo.
 *
 * Runs the exact same stages `lib/vision/pipeline.ts#recognize` does, but
 * calls each one individually and logs its intermediate result, so a failure
 * (or a suspiciously-off-but-not-throwing result) can be pinned to one stage
 * instead of only seeing the pipeline's final thrown error. Complements
 * `scripts/geometric-gate.ts` (which only reports pass/fail against ground
 * truth) for actually diagnosing *why* a specific photo goes wrong — see
 * `scripts/fixtures/photos/` for real photos that have previously done so.
 *
 * Usage: npx tsx scripts/diagnose-recognition.ts <photo-path> [tableSize] [cueBallColor]
 */

import { readFile } from 'node:fs/promises';
import { decodeImage } from '@/lib/vision/image';
import { segmentCloth } from '@/lib/vision/cloth';
import { detectTableBoundary } from '@/lib/vision/table';
import { buildTableFrame } from '@/lib/vision/camera';
import { detectBalls, classifyBallColors } from '@/lib/vision/balls';
import { scoreConfidence, needsManualCorrection } from '@/lib/vision/confidence';
import { loadOpenCv } from '@/lib/vision/opencv';
import { BALL_RADIUS_MM, CONFIDENCE_THRESHOLD, CUSHION_WIDTH_MM, MAX_IMAGE_DIMENSION } from '@/lib/vision/constants';
import type { TableSize } from '@/lib/types';

async function main(): Promise<void> {
  const [photoPath, tableSizeArg, cueBallColorArg] = process.argv.slice(2);
  if (!photoPath) {
    console.error('Usage: npx tsx scripts/diagnose-recognition.ts <photo-path> [대대|중대] [white|yellow]');
    process.exit(1);
  }
  const tableSize = (tableSizeArg ?? '대대') as TableSize;
  const cueBallColor = (cueBallColorArg ?? 'white') as 'white' | 'yellow';

  console.log(`\n=== ${photoPath} (tableSize=${tableSize}, cueBallColor=${cueBallColor}) ===\n`);

  // --- Step 1: decode + downscale -------------------------------------------
  const bytes = await readFile(photoPath);
  const image = await decodeImage(new Uint8Array(bytes), MAX_IMAGE_DIMENSION);
  console.log(`[1] decode: ${image.width}x${image.height}`);

  const cv = await loadOpenCv();

  // --- Step 2: cloth segmentation -------------------------------------------
  const segmentation = segmentCloth(cv, image);
  console.log(
    `[2] segmentCloth: hue=${segmentation.estimate.hue} tolerance=${segmentation.estimate.hueTolerance} ` +
      `satRange=[${segmentation.estimate.saturationRange}] valRange=[${segmentation.estimate.valueRange}] ` +
      `coverage=${(segmentation.estimate.coverage * 100).toFixed(1)}%`
  );

  // --- Step 3: table boundary ------------------------------------------------
  let table;
  try {
    table = detectTableBoundary(cv, segmentation.mask, image, tableSize);
  } catch (err) {
    console.error(`[3] detectTableBoundary FAILED: ${err instanceof Error ? err.message : err}`);
    return;
  }
  console.log(
    `[3] detectTableBoundary: boundary=${JSON.stringify(table.detection.boundary.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })))} ` +
      `clothCoverage=${(table.clothCoverage * 100).toFixed(1)}% observedAspectRatio=${table.observedAspectRatio.toFixed(3)} ` +
      `cornersOutOfFrame=${table.cornersOutOfFrame} warnings=${JSON.stringify(table.warnings)}`
  );
  // Each fitted line, in normal form (a*x + b*y + c = 0, a²+b²=1) plus the
  // [rangeLo, rangeHi] its own points actually spanned along the line — the
  // two numbers a bad line-intersection corner traces back to (see
  // lib/vision/table.ts#cornerExtrapolationErrorPx).
  console.log(
    `    sides: ${table.sides
      .map(
        (s, i) =>
          `#${i} rms=${s.rmsResidual.toFixed(2)}px n=${s.pointCount} span=${s.spanPx.toFixed(0)}px ` +
          `range=[${s.rangeLo.toFixed(0)},${s.rangeHi.toFixed(0)}] line=(a=${s.line.a.toFixed(3)},b=${s.line.b.toFixed(3)},c=${s.line.c.toFixed(1)})`
      )
      .join('\n           ')}`
  );
  // Corner i is lineIntersection(sides[i], sides[(i+1)%4]) before the
  // clockwise reorder into `boundary` — cornerExtrapolationErrorPx below is
  // already in `boundary`'s order (see table.ts), so it's shown alongside it.
  console.log(
    `    corners: ${table.detection.boundary
      .map(
        (c, i) =>
          `#${i} (${c.x.toFixed(0)},${c.y.toFixed(0)}) extrapolationErrorPx=${table.cornerExtrapolationErrorPx[i].toFixed(1)}`
      )
      .join(' | ')}`
  );
  // Edge i runs boundary[i] -> boundary[(i+1)%4] — see table.ts#computeVisibleFractions.
  console.log(
    `    edges: ${table.visibleFraction.map((f, i) => `#${i} visibleFraction=${f.toFixed(2)}`).join(' | ')} ` +
      `(lowEvidenceSideCount=${table.lowEvidenceSideCount})`
  );

  // --- Step 4: homography + pose ----------------------------------------------
  const frame = buildTableFrame(
    table.detection.boundary,
    tableSize,
    image.width,
    image.height,
    undefined,
    CUSHION_WIDTH_MM
  );
  console.log(
    `[4] buildTableFrame: focalPx=${frame.pose.intrinsics.focalPx.toFixed(0)} (${frame.pose.intrinsics.source}) ` +
      `cameraCenterMm=${JSON.stringify({ x: Math.round(frame.pose.centerMm.x), y: Math.round(frame.pose.centerMm.y), z: Math.round(frame.pose.centerMm.z) })} ` +
      `rectangleConsistency=${frame.rectangleConsistency.toFixed(4)}`
  );

  // --- Step 5: ball blobs ------------------------------------------------------
  const detection = detectBalls(
    cv,
    segmentation.mask,
    segmentation.rgb,
    image,
    frame,
    table.detection.boundary,
    BALL_RADIUS_MM,
    segmentation.estimate.hue
  );
  console.log(`[5] detectBalls: ${detection.candidates.length} candidate(s), ${detection.rejected.length} rejected`);
  for (const c of detection.candidates) {
    console.log(
      `    candidate at (${c.center.x.toFixed(1)}, ${c.center.y.toFixed(1)}) r=${c.radiusPx.toFixed(1)}px ` +
        `expected=${c.expectedRadiusPx.toFixed(1)}px ratio=${c.radiusRatio.toFixed(2)} circ=${c.circularity.toFixed(2)} ` +
        `rgb=${JSON.stringify(c.rgb)} score=${c.score.toFixed(3)}`
    );
  }
  for (const r of detection.rejected) {
    console.log(`    rejected at (${r.center.x.toFixed(1)}, ${r.center.y.toFixed(1)}): ${r.reason}`);
  }

  if (detection.candidates.length < 4) {
    console.error(`\n[STOP] Only ${detection.candidates.length}/4 balls found — recognize() would throw here.`);
    return;
  }

  // --- Step 6: colour classification -------------------------------------------
  const chosen = detection.candidates.slice(0, 4);
  const assignment = classifyBallColors(chosen.map((c) => c.rgb));
  console.log(`[6] classifyBallColors: margin=${assignment.margin.toFixed(3)} rationale="${assignment.rationale}"`);

  // --- Step 7: confidence --------------------------------------------------------
  // Mirrors pipeline.ts's own scoreConfidence call exactly (including the
  // corner-extrapolation/low-evidence-side signals) so this diagnostic's
  // number matches what recognize() actually produces.
  const breakdown = scoreConfidence({
    sideResidualsPx: [...table.sides.map((s) => s.rmsResidual), ...table.cornerExtrapolationErrorPx],
    imageDiagonalPx: Math.hypot(image.width, image.height),
    lowEvidenceSideCount: table.lowEvidenceSideCount,
    rectangleConsistency: frame.rectangleConsistency,
    ballsFound: chosen.length,
    meanBallScore: chosen.reduce((a, c) => a + c.score, 0) / chosen.length,
    colorMargin: assignment.margin,
    cameraHeightMm: frame.pose.centerMm.z,
    focalWasMeasured: frame.pose.intrinsics.source !== 'assumed',
    radiusScaleCorrection: detection.radiusScaleCorrection,
  });
  console.log(
    `[7] scoreConfidence: ${JSON.stringify(Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Number(v.toFixed(3))])))}`
  );
  console.log(`[7] needsManualCorrection: ${needsManualCorrection(breakdown.overall, CONFIDENCE_THRESHOLD)}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
