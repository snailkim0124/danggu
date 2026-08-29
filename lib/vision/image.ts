/**
 * Image container + the mandatory pre-CV downscale.
 *
 * The pipeline works on plain RGBA byte buffers rather than OpenCV `Mat`s at
 * its boundaries, so callers (an API route, the geometric-gate harness, a
 * browser canvas) never have to know about WASM lifetimes.
 */

import { MAX_IMAGE_DIMENSION } from './constants';

/** Tightly-packed 8-bit RGBA image, row-major, no stride padding. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Length must be exactly `width * height * 4`. */
  data: Uint8ClampedArray;
}

export function createRgbaImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function assertValidImage(img: RgbaImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height)) {
    throw new Error('Image dimensions must be integers');
  }
  if (img.width <= 0 || img.height <= 0) {
    throw new Error('Image dimensions must be positive');
  }
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(
      `Image buffer length ${img.data.length} does not match ${img.width}x${img.height}x4 = ` +
        `${img.width * img.height * 4}`
    );
  }
}

/**
 * Downscale so neither side exceeds `maxDimension`, preserving aspect ratio.
 * A no-op (returns the same object) when the image already fits.
 *
 * This is plan Phase 1 step 1 and is a hard requirement, not an optimisation:
 * a 12MP phone photo run through OpenCV.js (WASM) blows past Vercel's
 * serverless execution budget. Doing it here — rather than relying on the
 * decoder to have done it — means every entry point into the pipeline is
 * bounded, including the raw-pixel path used by tests and the harness.
 *
 * Uses box (area-average) resampling. Nearest-neighbour would alias the cloth
 * texture into false edges and break line fitting; box averaging is the same
 * thing `INTER_AREA` does and is cheap enough to keep in pure TS, which avoids
 * an ordering dependency on the WASM module being loaded first.
 */
export function downscaleToMaxDimension(
  img: RgbaImage,
  maxDimension: number = MAX_IMAGE_DIMENSION
): RgbaImage {
  assertValidImage(img);
  const longest = Math.max(img.width, img.height);
  if (longest <= maxDimension) return img;

  const scale = maxDimension / longest;
  const dstW = Math.max(1, Math.round(img.width * scale));
  const dstH = Math.max(1, Math.round(img.height * scale));
  const out = createRgbaImage(dstW, dstH);

  const xRatio = img.width / dstW;
  const yRatio = img.height / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.min(img.height, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.min(img.width, Math.ceil((dx + 1) * xRatio)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * img.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += img.data[idx];
          g += img.data[idx + 1];
          b += img.data[idx + 2];
          a += img.data[idx + 3];
          idx += 4;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/** Read one pixel as [r, g, b]. Out-of-range coordinates are clamped. */
export function samplePixel(img: RgbaImage, x: number, y: number): [number, number, number] {
  const px = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const i = (py * img.width + px) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode an encoded image (JPEG/PNG/WebP/HEIC-as-supported) into RGBA,
 * applying EXIF orientation and downscaling in one pass.
 *
 * `sharp` is resolved dynamically rather than imported statically because it
 * is a native module: a static import would drag it into every bundle that
 * touches `lib/vision`, including client-side ones where it cannot run. It is
 * a declared dependency and Vercel supports it first-class (it is the same
 * library `next/image` optimisation uses), so this is not a native-binding
 * risk of the kind that ruled out `opencv4nodejs`. Callers that already hold
 * decoded pixels should feed an `RgbaImage` in directly — the `raw` request
 * form on `/api/recognize` exists for exactly that and needs no decoder.
 *
 * EXIF orientation matters more than it looks: phone photos are routinely
 * stored rotated with an orientation tag, and an unrotated buffer would make
 * the table quad and every ball position wrong in a way that still *looks*
 * like a plausible detection.
 */
export async function decodeImage(
  buffer: Uint8Array,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<RgbaImage> {
  const sharp = await loadSharp();
  const pipeline = sharp(buffer)
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw();
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`decodeImage: expected 4 channels after ensureAlpha, got ${info.channels}`);
  }
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** Encode an RGBA image as PNG. Used by the geometric-gate fixture generator. */
export async function encodePng(img: RgbaImage): Promise<Uint8Array> {
  assertValidImage(img);
  const sharp = await loadSharp();
  const buf = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/** The callable `sharp(...)` factory, not the module namespace around it. */
type SharpFactory = (typeof import('sharp'))['default'];

let sharpPromise: Promise<SharpFactory> | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((m) => m.default)
      .catch((err: unknown) => {
        sharpPromise = null;
        throw new Error(
          'Image decoding requires the "sharp" module, which could not be loaded ' +
            `(${err instanceof Error ? err.message : String(err)}). Either install it, or send ` +
            'raw RGBA pixels to /api/recognize instead of an encoded file.'
        );
      });
  }
  return sharpPromise;
}
