/**
 * Draws `detectTableBoundary`'s fitted quad (4 fitted-line corners, numbered)
 * directly onto the source photo as a PNG, so a bad detection can be *seen*
 * instead of only inferred from mm-error numbers. Built while investigating
 * why the geometric gate's real-photo batch (2026-08-30,
 * `docs/testing/geometric-gate-guide.md`) had near-zero `rectangleConsistency`
 * almost everywhere — this is what actually found the cause: at least one
 * fitted corner can land far outside the table (extrapolated from a short,
 * only-mildly-noisy line segment) while every per-side RMS/point-count number
 * still looks unremarkable, which no purely-numeric report makes obvious.
 *
 * Usage: npx tsx scripts/visualize-boundary.ts <photo-path> [out-path] [tableSize]
 *   out-path defaults to <photo-path>.boundary.png next to the source photo.
 */

import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { decodeImage } from '@/lib/vision/image';
import { segmentCloth } from '@/lib/vision/cloth';
import { detectTableBoundary } from '@/lib/vision/table';
import { loadOpenCv } from '@/lib/vision/opencv';
import { MAX_IMAGE_DIMENSION } from '@/lib/vision/constants';
import type { TableSize } from '@/lib/types';

async function main(): Promise<void> {
  const photoPath = process.argv[2];
  if (!photoPath) {
    console.error('Usage: npx tsx scripts/visualize-boundary.ts <photo-path> [out-path] [tableSize]');
    process.exit(1);
  }
  const outPath = process.argv[3] ?? `${photoPath}.boundary.png`;
  const tableSize = (process.argv[4] ?? '중대') as TableSize;

  const bytes = await readFile(photoPath);
  const image = await decodeImage(new Uint8Array(bytes), MAX_IMAGE_DIMENSION);
  const cv = await loadOpenCv();
  const segmentation = segmentCloth(cv, image);
  const table = detectTableBoundary(cv, segmentation.mask, image, tableSize);
  const boundary = table.detection.boundary;

  console.log('boundary (image px):', boundary.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));
  console.log('cornersOutOfFrame:', table.cornersOutOfFrame);
  for (const [i, s] of table.sides.entries()) {
    console.log(`  side ${i}: n=${s.pointCount} rms=${s.rmsResidual.toFixed(1)}px span=${s.spanPx.toFixed(0)}px`);
  }

  const svg = `<svg width="${image.width}" height="${image.height}" xmlns="http://www.w3.org/2000/svg">
    <polygon points="${boundary.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="lime" stroke-width="6"/>
    ${boundary
      .map(
        (p, i) =>
          `<circle cx="${p.x}" cy="${p.y}" r="14" fill="red"/><text x="${p.x + 18}" y="${p.y}" fill="yellow" font-size="40" stroke="black" stroke-width="1">${i}</text>`
      )
      .join('\n')}
  </svg>`;

  const rgbaBuffer = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const png = await sharp(rgbaBuffer, { raw: { width: image.width, height: image.height, channels: 4 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  await writeFile(outPath, png);
  console.log('wrote', outPath);
}

main().catch((err) => {
  console.error('visualize-boundary: unexpected crash —', err);
  process.exit(1);
});
