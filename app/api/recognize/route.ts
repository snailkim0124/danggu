/**
 * POST /api/recognize — photo in, recognised table + balls out.
 *
 * Request (two accepted forms)
 * ----------------------------
 * 1. `multipart/form-data` — the primary form, what a mobile browser's
 *    `<input type="file" capture>` produces directly.
 *      - `image`      (required) the photo file
 *      - `tableSize`  (optional) '대대' | '중대'          — default '대대'
 *      - `cueBallColor` (optional) 'white' | 'yellow'    — default 'white'
 *
 * 2. `application/json` — for clients that already hold pixels or a data URL:
 *      { imageBase64: string, tableSize?, cueBallColor? }
 *    or, skipping decoding entirely (used by tests and tooling):
 *      { raw: { width: number, height: number, dataBase64: string },
 *        tableSize?, cueBallColor? }
 *    `raw.dataBase64` is base64 of a tightly-packed RGBA byte buffer of length
 *    `width * height * 4`.
 *
 * In production `tableSize`/`cueBallColor` come from the user's saved
 * `Settings` (plan Phase 4). They are accepted per-request here so this route
 * is usable before the settings API lands, and so the geometric-gate harness
 * can drive it directly.
 *
 * Response 200
 * ------------
 * ```
 * {
 *   recognition:    RecognitionResult,   // mm space — feeds lib/pathcalc
 *   pixelDetection: PixelDetection,      // pixel space — feeds the confirm/correct screen
 *   diagnostics:    RecognizeDiagnostics // confidence breakdown, timings, warnings
 * }
 * ```
 *
 * `pixelDetection` exists because the confirm/correct screen has to draw the
 * detection back onto the original photo and let the user drag it, which mm
 * coordinates cannot express. Its coordinates are in the space of the
 * **downscaled** image (`pixelDetection.imageWidth`/`imageHeight`); to overlay
 * on the original upload, multiply by `originalWidth / pixelDetection.imageWidth`.
 * The downscale preserves aspect ratio, so that single factor is correct for
 * both axes. Shape is defined by `PixelDetection` in `lib/vision/pipeline.ts`.
 *
 * Error responses carry `{ error, stage }` and a 4xx/5xx status; `stage` says
 * where it broke ('request' | 'decode' | 'recognition') so the client can tell
 * "your photo didn't work" from "the server is broken".
 */

import { NextResponse } from 'next/server';
import { TABLE_DIMENSIONS_MM, type Settings, type TableSize } from '@/lib/types';
import { type RgbaImage, decodeImage, recognize } from '@/lib/vision';

// OpenCV.js is a WASM module and `sharp` is a native module: neither can run
// on the Edge runtime.
export const runtime = 'nodejs';
// Recognition on a cold container is dominated by the one-time WASM
// instantiation. The default 10s Vercel limit is uncomfortably tight for that
// plus a 1600px pipeline run; see plan Risk "Vercel 서버리스 함수 실행시간/메모리 제한".
export const maxDuration = 60;
// Every request carries its own image, so nothing here is cacheable.
export const dynamic = 'force-dynamic';

/** Hard cap on the upload size, before decoding. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: 'request' | 'decode' | 'recognition'
  ) {
    super(message);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const { image, settings } = await parseRequest(request);

    const output = await recognize(image, settings);

    const { diagnostics } = output;
    console.info(
      '[recognize] ok',
      JSON.stringify({
        ms: Date.now() - startedAt,
        image: `${output.pixelDetection.imageWidth}x${output.pixelDetection.imageHeight}`,
        confidence: Number(output.recognition.confidence.toFixed(3)),
        needsManualCorrection: output.recognition.needsManualCorrection,
        breakdown: roundAll(diagnostics.confidence),
        cloth: {
          hue: diagnostics.cloth.hue,
          tolerance: diagnostics.cloth.hueTolerance,
          coverage: Number(diagnostics.cloth.coverage.toFixed(3)),
        },
        focalPx: Math.round(diagnostics.focalPx),
        focalSource: diagnostics.focalSource,
        cameraHeightMm: Math.round(diagnostics.cameraCenterMm.z),
        // The single most important number to watch in production: if this is
        // near zero the parallax correction silently stopped doing anything.
        parallaxMm: diagnostics.parallaxCorrectionMm.map((v) => Number(v.toFixed(1))),
        cornersOutOfFrame: diagnostics.cornersOutOfFrame,
        candidates: diagnostics.ballCandidatesConsidered,
        colors: diagnostics.colorRationale,
        timings: diagnostics.timingsMs,
        warnings: diagnostics.warnings,
      })
    );

    return NextResponse.json(output, { status: 200 });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const stage = err instanceof RequestError ? err.stage : 'recognition';
    const message = err instanceof Error ? err.message : String(err);

    // Log the stack server-side; return only the message to the client.
    console.error(
      '[recognize] failed',
      JSON.stringify({ ms: Date.now() - startedAt, stage, message }),
      err instanceof Error ? err.stack : undefined
    );

    return NextResponse.json({ error: message, stage }, { status });
  }
}

async function parseRequest(
  request: Request
): Promise<{ image: RgbaImage; settings: Settings }> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => {
      throw new RequestError('Malformed multipart/form-data body.', 400, 'request');
    });
    const file = form.get('image');
    if (!(file instanceof File)) {
      throw new RequestError('Missing "image" file field in the form data.', 400, 'request');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new RequestError(
        `Uploaded image is ${(file.size / 1e6).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1e6}MB.`,
        413,
        'request'
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      image: await decode(bytes),
      settings: readSettings((k) => asString(form.get(k))),
    };
  }

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => {
      throw new RequestError('Malformed JSON body.', 400, 'request');
    })) as Record<string, unknown>;

    const settings = readSettings((k) => asString(body[k]));

    if (body.raw && typeof body.raw === 'object') {
      return { image: parseRawImage(body.raw as Record<string, unknown>), settings };
    }
    if (typeof body.imageBase64 === 'string') {
      return { image: await decode(decodeBase64(body.imageBase64, 'imageBase64')), settings };
    }
    throw new RequestError(
      'JSON body must contain either "imageBase64" or "raw" { width, height, dataBase64 }.',
      400,
      'request'
    );
  }

  throw new RequestError(
    `Unsupported Content-Type "${contentType || '(none)'}". Send multipart/form-data with an ` +
      '"image" file, or application/json with "imageBase64" or "raw".',
    415,
    'request'
  );
}

async function decode(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.byteLength === 0) {
    throw new RequestError('The uploaded image is empty.', 400, 'request');
  }
  try {
    return await decodeImage(bytes);
  } catch (err) {
    throw new RequestError(
      `Could not decode the image: ${err instanceof Error ? err.message : String(err)}`,
      400,
      'decode'
    );
  }
}

function parseRawImage(raw: Record<string, unknown>): RgbaImage {
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RequestError('"raw.width" and "raw.height" must be positive integers.', 400, 'request');
  }
  if (typeof raw.dataBase64 !== 'string') {
    throw new RequestError('"raw.dataBase64" must be a base64 string.', 400, 'request');
  }
  const bytes = decodeBase64(raw.dataBase64, 'raw.dataBase64');
  if (bytes.byteLength !== width * height * 4) {
    throw new RequestError(
      `"raw.dataBase64" decodes to ${bytes.byteLength} bytes, expected ${width * height * 4} ` +
        `for a ${width}x${height} RGBA image.`,
      400,
      'request'
    );
  }
  return { width, height, data: new Uint8ClampedArray(bytes) };
}

function decodeBase64(value: string, field: string): Uint8Array {
  // Accept a bare base64 payload or a full `data:image/jpeg;base64,...` URL.
  const commaIndex = value.startsWith('data:') ? value.indexOf(',') : -1;
  const payload = commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  try {
    return new Uint8Array(Buffer.from(payload, 'base64'));
  } catch {
    throw new RequestError(`"${field}" is not valid base64.`, 400, 'request');
  }
}

function readSettings(get: (key: string) => string | undefined): Settings {
  const tableSize = get('tableSize') ?? '대대';
  if (!isTableSize(tableSize)) {
    throw new RequestError(
      `"tableSize" must be one of ${Object.keys(TABLE_DIMENSIONS_MM).join(' | ')}, got "${tableSize}".`,
      400,
      'request'
    );
  }
  const cueBallColor = get('cueBallColor') ?? 'white';
  if (cueBallColor !== 'white' && cueBallColor !== 'yellow') {
    throw new RequestError(
      `"cueBallColor" must be "white" or "yellow", got "${cueBallColor}".`,
      400,
      'request'
    );
  }
  return { tableSize, cueBallColor };
}

function isTableSize(value: string): value is TableSize {
  return Object.prototype.hasOwnProperty.call(TABLE_DIMENSIONS_MM, value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function roundAll(obj: object): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Number(v.toFixed(3))]));
}
