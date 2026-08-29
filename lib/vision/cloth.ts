/**
 * Cloth segmentation — finds "which pixels are the playing surface".
 *
 * Everything downstream (table sides, ball blobs) is derived from this mask,
 * so it is deliberately *not* keyed to a hardcoded green. Korean 당구장 cloth
 * runs from blue-green to a saturated blue, and tungsten-vs-LED house lighting
 * moves the measured hue substantially — the same table can read as hue 95 in
 * one hall and hue 108 in another. A fixed range would work in one venue and
 * fail silently in the next.
 *
 * Instead the dominant hue is *measured from the photo itself*: the cloth is
 * by far the largest saturated, evenly-lit region in any picture of a billiard
 * table, so the peak of the chroma-weighted hue histogram is the cloth. The
 * mask bounds are then derived from percentiles of the pixels around that
 * peak, which makes the whole step self-calibrating per photo.
 */

import { type CV, CvScope } from './opencv';
import type { RgbaImage } from './image';

/** OpenCV's 8-bit HSV uses H in [0, 180). */
const HUE_BINS = 180;

export interface ClothEstimate {
  /** Dominant hue of the cloth, in OpenCV's 0..179 scale. */
  hue: number;
  /** Half-width of the accepted hue window, in the same scale. */
  hueTolerance: number;
  saturationRange: [number, number];
  valueRange: [number, number];
  /** Fraction of image pixels the resulting mask covers (0..1). */
  coverage: number;
}

export interface ClothSegmentation {
  estimate: ClothEstimate;
  /** 8UC1 mask, 255 = cloth. Caller owns it and must `delete()` it. */
  mask: InstanceType<CV['Mat']>;
  /** 8UC3 HSV image. Caller owns it and must `delete()` it. */
  hsv: InstanceType<CV['Mat']>;
  /** 8UC3 RGB image. Caller owns it and must `delete()` it. */
  rgb: InstanceType<CV['Mat']>;
}

/** Circular distance between two hues on the 0..179 wheel. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % HUE_BINS;
  return Math.min(d, HUE_BINS - d);
}

/** Circular mean of hues weighted by `weights`, on the 0..179 wheel. */
export function circularHueMean(hues: readonly number[], weights?: readonly number[]): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < hues.length; i++) {
    const w = weights?.[i] ?? 1;
    const theta = (hues[i] / HUE_BINS) * 2 * Math.PI;
    sx += w * Math.cos(theta);
    sy += w * Math.sin(theta);
  }
  if (sx === 0 && sy === 0) return 0;
  let angle = Math.atan2(sy, sx);
  if (angle < 0) angle += 2 * Math.PI;
  return (angle / (2 * Math.PI)) * HUE_BINS;
}

/**
 * Build the cloth mask for an image.
 *
 * The returned Mats are owned by the caller. Wrap the call in a `CvScope` and
 * track all three, or call `disposeSegmentation`.
 */
export function segmentCloth(cv: CV, image: RgbaImage): ClothSegmentation {
  const scope = new CvScope();
  let mask: InstanceType<CV['Mat']> | null = null;
  let hsv: InstanceType<CV['Mat']> | null = null;
  let rgb: InstanceType<CV['Mat']> | null = null;
  try {
    const rgba = scope.track(
      cv.matFromArray(image.height, image.width, cv.CV_8UC4, Array.from(image.data))
    );
    rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);

    // Light blur before hue analysis: cloth weave and JPEG noise both produce
    // isolated off-hue pixels that would otherwise widen the estimated window.
    const blurred = scope.track(new cv.Mat());
    cv.GaussianBlur(rgb, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    hsv = new cv.Mat();
    cv.cvtColor(blurred, hsv, cv.COLOR_RGB2HSV);

    const estimate = estimateClothColor(hsv.data, image.width * image.height);

    mask = new cv.Mat();
    const loHue = estimate.hue - estimate.hueTolerance;
    const hiHue = estimate.hue + estimate.hueTolerance;
    if (loHue < 0 || hiHue >= HUE_BINS) {
      // The window straddles the 0/179 wrap-around (a genuinely red cloth, or
      // a strongly warm-lit surface). `inRange` has no notion of a circular
      // channel, so the window is split into two and OR-ed.
      buildWrappedHueMask(cv, scope, hsv, estimate, mask);
    } else {
      const loMat = scope.track(
        new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC3, new cv.Scalar(loHue, estimate.saturationRange[0], estimate.valueRange[0]))
      );
      const hiMat = scope.track(
        new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC3, new cv.Scalar(hiHue, estimate.saturationRange[1], estimate.valueRange[1]))
      );
      cv.inRange(hsv, loMat, hiMat, mask);
    }

    // Close over the balls and chalk marks so the cloth region becomes one
    // solid blob whose outline is the cushion line, then open to drop
    // speckle. Kernel size scales with the image so behaviour is resolution
    // independent.
    const k = Math.max(3, Math.round(Math.min(image.width, image.height) * 0.006) | 1);
    const kernel = scope.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);

    estimate.coverage = cv.countNonZero(mask) / (image.width * image.height);
    return { estimate, mask, hsv, rgb };
  } catch (err) {
    mask?.delete();
    hsv?.delete();
    rgb?.delete();
    throw err;
  } finally {
    scope.dispose();
  }
}

export function disposeSegmentation(seg: ClothSegmentation): void {
  seg.mask.delete();
  seg.hsv.delete();
  seg.rgb.delete();
}

function buildWrappedHueMask(
  cv: CV,
  scope: CvScope,
  hsv: InstanceType<CV['Mat']>,
  estimate: ClothEstimate,
  out: InstanceType<CV['Mat']>
): void {
  const [sLo, sHi] = estimate.saturationRange;
  const [vLo, vHi] = estimate.valueRange;
  const lowEnd = wrapHue(estimate.hue - estimate.hueTolerance);
  const highEnd = wrapHue(estimate.hue + estimate.hueTolerance);

  const maskA = scope.track(new cv.Mat());
  const maskB = scope.track(new cv.Mat());
  const bounds = (h0: number, s: number, v: number) =>
    scope.track(new cv.Mat(hsv.rows, hsv.cols, cv.CV_8UC3, new cv.Scalar(h0, s, v)));

  cv.inRange(hsv, bounds(lowEnd, sLo, vLo), bounds(HUE_BINS - 1, sHi, vHi), maskA);
  cv.inRange(hsv, bounds(0, sLo, vLo), bounds(highEnd, sHi, vHi), maskB);
  cv.bitwise_or(maskA, maskB, out);
}

function wrapHue(h: number): number {
  return ((Math.round(h) % HUE_BINS) + HUE_BINS) % HUE_BINS;
}

/**
 * Estimate the cloth's HSV signature from an HSV byte buffer.
 *
 * Exported (and free of any OpenCV type) so it can be unit-tested against
 * synthetic HSV buffers without loading WASM.
 */
export function estimateClothColor(hsvData: Uint8Array, pixelCount: number): ClothEstimate {
  // Subsample: 200k pixels is far more than enough to locate a histogram peak
  // covering ~half the frame, and keeps this step at a few milliseconds.
  const stride = Math.max(1, Math.floor(pixelCount / 200_000));

  const histogram = new Float64Array(HUE_BINS);
  for (let i = 0; i < pixelCount; i += stride) {
    const o = i * 3;
    const s = hsvData[o + 1];
    const v = hsvData[o + 2];
    // Ignore near-grey and near-black pixels: their hue is numerical noise.
    if (s < 40 || v < 30) continue;
    // Weight by chroma so a strongly coloured pixel counts for more than a
    // barely-tinted one.
    histogram[hsvData[o]] += (s / 255) * (v / 255);
  }

  // Smooth circularly before peak-picking; an unsmoothed histogram peaks on
  // whichever single bin happened to win, which jitters the window centre.
  const smoothed = new Float64Array(HUE_BINS);
  const radius = 3;
  for (let h = 0; h < HUE_BINS; h++) {
    let sum = 0;
    for (let d = -radius; d <= radius; d++) sum += histogram[(h + d + HUE_BINS) % HUE_BINS];
    smoothed[h] = sum;
  }

  let peak = 0;
  for (let h = 1; h < HUE_BINS; h++) if (smoothed[h] > smoothed[peak]) peak = h;

  // Widen the window until it covers the bulk of the peak's mass, capped so a
  // photo with no dominant colour cannot degenerate into "everything is cloth".
  const total = smoothed.reduce((a, b) => a + b, 0);
  let covered = smoothed[peak];
  let tolerance = 1;
  const MAX_TOLERANCE = 22;
  while (tolerance < MAX_TOLERANCE && covered < 0.6 * total) {
    covered +=
      smoothed[(peak - tolerance + HUE_BINS) % HUE_BINS] + smoothed[(peak + tolerance) % HUE_BINS];
    tolerance++;
  }

  // Floor the tolerance regardless of how fast the mass threshold was met.
  //
  // A photo lit brightly and evenly enough that the cloth's own histogram peak
  // is extremely sharp (all of it near-identical hue) satisfies the 60% mass
  // target within just a couple of degrees — but that says nothing about the
  // *rest* of the cloth. Shadowed cloth (e.g. along the far cushion, away from
  // the light source) was assumed above to keep its hue "almost untouched" by
  // shadow, but in practice a real camera's colour response shifts it by
  // several degrees, not zero. A window that is only as wide as the brightest
  // patch of cloth then excludes the shadowed cloth elsewhere in the same
  // photo as "not cloth" — and any ball sitting on or near that shadowed strip
  // gets its blob shredded by the morphological open step along with the false
  // "not cloth" noise, rather than staying one clean, correctly-sized circle.
  // A handful of degrees of slack costs nothing against genuinely different
  // colours (a red ball is ~70-90 bins away on this wheel) but is the
  // difference between keeping and losing shadowed cloth.
  const MIN_HUE_TOLERANCE = 8;
  tolerance = Math.max(tolerance, MIN_HUE_TOLERANCE);

  // Saturation / value bounds from the percentiles of the pixels that actually
  // fall inside the hue window, so a dim hall and a bright one both work.
  const sats: number[] = [];
  const vals: number[] = [];
  for (let i = 0; i < pixelCount; i += stride) {
    const o = i * 3;
    if (hueDistance(hsvData[o], peak) > tolerance) continue;
    const s = hsvData[o + 1];
    const v = hsvData[o + 2];
    if (s < 40 || v < 30) continue;
    sats.push(s);
    vals.push(v);
  }

  const satRange = percentileRange(sats, 0.05, 0.98, [40, 255]);
  const valRange = percentileRange(vals, 0.05, 0.98, [30, 255]);

  // Loosen the low end hard, especially on value.
  //
  // Shadow scales all three RGB channels by roughly the same factor, which
  // leaves hue and saturation almost untouched and drops *only* value. So
  // shadowed cloth is still unmistakably cloth by hue and saturation, and the
  // value floor should be doing almost no discriminating work — its only job
  // is to exclude pixels so dark their hue is numerically meaningless.
  //
  // A tight value floor is actively harmful: every ball casts a shadow, and
  // any part of that shadow excluded from the cloth mask gets absorbed into
  // the ball's blob instead, inflating its measured area severalfold and
  // pushing it outside the size filter. Cushion-shadowed cloth along the far
  // rail is the same story, and losing it costs the far cushion line.
  satRange[0] = Math.max(20, satRange[0] * 0.5);
  valRange[0] = Math.max(18, valRange[0] * 0.3);

  // The saturation *ceiling* needs the opposite correction, and for a
  // different reason: `S = (max-min)/max` is numerically unstable as V→0.
  // Sensor noise near black does not scale every channel down by the same
  // factor the way the comment above assumes for well-lit shadow — a pixel
  // that reads e.g. RGB(0,17,66) has max=66 but min≈0, so it computes a
  // near-maximum saturation (~250+) despite being an unremarkable dark,
  // shadowed patch of blue cloth to the eye. A saturation ceiling fitted to
  // the well-lit majority of the cloth (which sits far lower, ~180-200) then
  // excludes exactly this shadowed-and-therefore-noisy cloth as "not cloth" —
  // the same failure mode as the value floor above, just from the other
  // direction. Hue is already the primary discriminator (a ball is 70-90 bins
  // away on the wheel, not a few), so the saturation ceiling has little
  // real discriminating work left to do and is dropped rather than tightened.
  satRange[1] = 255;

  return {
    hue: peak,
    hueTolerance: tolerance,
    saturationRange: satRange,
    valueRange: valRange,
    coverage: 0,
  };
}

function percentileRange(
  values: number[],
  lowQ: number,
  highQ: number,
  fallback: [number, number]
): [number, number] {
  if (values.length < 32) return [...fallback];
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  return [at(lowQ), at(highQ)];
}
