/**
 * The Vision Recognition pipeline: photo in, `RecognitionResult` out.
 *
 * Order of operations follows plan Phase 1 exactly:
 *   1. downscale                        (`image.ts`)
 *   2. cloth segmentation + 4-side line fit → table quad   (`cloth.ts`, `table.ts`)
 *   3. homography + camera pose         (`camera.ts`)
 *   4. ball blobs → z=radius reprojection (`balls.ts`, `camera.ts`)
 *   5. relative white/yellow + red pair classification     (`balls.ts`)
 *   6. confidence → needsManualCorrection (`confidence.ts`)
 *
 * Step 3 is not optional and is not bolted on after the fact: the pose is
 * recovered before any ball position is emitted, because `Ball.position` is
 * *defined* by `lib/types.ts` as the z=ball-radius corrected coordinate.
 */

import {
  TABLE_DIMENSIONS_MM,
  type Ball,
  type BallColor,
  type BallRole,
  type Point,
  type RecognitionResult,
  type Settings,
} from '@/lib/types';
import { type TableFrame, ballImagePointToTableMm, buildTableFrame, projectTablePoint } from './camera';
import { type BallCandidate, classifyBallColors, detectBalls } from './balls';
import { type ConfidenceBreakdown, needsManualCorrection, scoreConfidence } from './confidence';
import { BALL_RADIUS_MM, CONFIDENCE_THRESHOLD, CUSHION_WIDTH_MM, MAX_IMAGE_DIMENSION } from './constants';
import { type ClothEstimate, disposeSegmentation, segmentCloth } from './cloth';
import { type RgbaImage, assertValidImage, downscaleToMaxDimension } from './image';
import { detectTableBoundary, rectifiedBoundary } from './table';
import { loadOpenCv } from './opencv';
import type { Vec2 } from './geometry';

export interface RecognizeOptions {
  /** Longest image side after downscale. Defaults to `MAX_IMAGE_DIMENSION`. */
  maxDimension?: number;
  /** Ball radius in mm. Defaults to `BALL_RADIUS_MM` (65.5mm Korean 4구 carom balls). */
  ballRadiusMm?: number;
  /** Confidence below which manual correction is demanded. */
  confidenceThreshold?: number;
  /** Nose-line-to-outer-rail distance in mm. Defaults to `CUSHION_WIDTH_MM`.
   * Override for a specific table's measured cushion width. */
  cushionWidthMm?: number;
}

/**
 * Pixel-space detections, kept alongside the mm-space `RecognitionResult`.
 *
 * The confirm/correct screen has to draw the detection back onto the original
 * photo and let the user drag things, which needs image coordinates — the
 * rectified mm coordinates in `RecognitionResult` are useless for that. These
 * are the pipeline's own intermediates, exposed rather than discarded.
 *
 * **All coordinates are in the pixel space of the DOWNSCALED image**, whose
 * dimensions are given by `imageWidth`/`imageHeight`. To overlay on the
 * original upload, scale by `originalWidth / imageWidth`. The downscale
 * preserves aspect ratio, so one uniform factor is correct for both axes.
 */
export interface PixelDetection {
  imageWidth: number;
  imageHeight: number;
  /**
   * Cushion-nose quad in image pixels, clockwise: [TL, TR, BR, BL] — the line
   * a ball actually rolls to and bounces off, **not** the outer edge of the
   * cloth (see `outerTableBoundary`). Computed by projecting the corrected
   * `TableFrame`'s own `(0,0)..(widthMm,heightMm)` rectangle back into image
   * pixels (`CUSHION_WIDTH_MM`-corrected — see `lib/vision/constants.ts`), so
   * it already accounts for the same perspective the rest of the frame does.
   * This is what the confirm screen shows and lets the user drag-correct
   * further; a corrected quad is fed straight back into `buildTableFrame`
   * with no further cushion-width correction (it's already the nose line).
   */
  tableBoundary: [Point, Point, Point, Point];
  /** The raw outer-rail edge `detectTableBoundary` actually segmented, before
   * the `CUSHION_WIDTH_MM` correction — shown as a secondary reference outline
   * so the user can see both lines while dragging `tableBoundary` into place. */
  outerTableBoundary: [Point, Point, Point, Point];
  /** One entry per identified ball, in the same order as `RecognitionResult.balls`. */
  balls: Array<{
    id: string;
    color: BallColor;
    role: BallRole;
    /** Ball centre in image pixels. */
    x: number;
    y: number;
    /** Fitted ball radius in image pixels — use it to size the drag handle. */
    radiusPx: number;
  }>;
}

export interface RecognizeDiagnostics {
  confidence: ConfidenceBreakdown;
  cloth: ClothEstimate;
  /** Focal length in px and how it was obtained. */
  focalPx: number;
  focalSource: string;
  /** Camera position in table mm coordinates; `z` is height above the cloth. */
  cameraCenterMm: { x: number; y: number; z: number };
  /** Per-ball distance in mm between the naive z=0 mapping and the corrected
   * z=radius position. This is the parallax error that would have been shipped
   * had step 4 been skipped — logged so its magnitude is observable in
   * production, not just asserted in a test. */
  parallaxCorrectionMm: number[];
  cornersOutOfFrame: number;
  observedAspectRatio: number;
  ballCandidatesConsidered: number;
  colorRationale: string;
  warnings: string[];
  timingsMs: Record<string, number>;
}

export interface RecognizeOutput {
  recognition: RecognitionResult;
  pixelDetection: PixelDetection;
  diagnostics: RecognizeDiagnostics;
}

/** Deterministic ball ids, so re-running on the same photo is stable. */
const BALL_IDS: Record<BallColor, string> = {
  white: 'ball-white',
  yellow: 'ball-yellow',
  red1: 'ball-red1',
  red2: 'ball-red2',
};

/**
 * Run the full recognition pipeline.
 *
 * Throws on unrecoverable failures (no table found, degenerate geometry).
 * Recoverable doubt is expressed through `confidence` /
 * `needsManualCorrection` rather than an exception — the product's answer to
 * an uncertain photo is the correction screen, not an error.
 */
export async function recognize(
  input: RgbaImage,
  settings: Settings,
  options: RecognizeOptions = {}
): Promise<RecognizeOutput> {
  assertValidImage(input);
  const maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION;
  const ballRadiusMm = options.ballRadiusMm ?? BALL_RADIUS_MM;
  const threshold = options.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
  const cushionWidthMm = options.cushionWidthMm ?? CUSHION_WIDTH_MM;

  const timingsMs: Record<string, number> = {};
  const clock = <T>(label: string, fn: () => T): T => {
    const t0 = Date.now();
    try {
      return fn();
    } finally {
      timingsMs[label] = Date.now() - t0;
    }
  };

  // Step 1 — downscale before touching OpenCV at all.
  const image = clock('downscale', () => downscaleToMaxDimension(input, maxDimension));

  const tLoad = Date.now();
  const cv = await loadOpenCv();
  timingsMs.opencvLoad = Date.now() - tLoad;

  const segmentation = clock('segmentCloth', () => segmentCloth(cv, image));
  try {
    // Step 2 — four cushion lines → quad.
    const table = clock('detectTable', () =>
      detectTableBoundary(cv, segmentation.mask, image, settings.tableSize)
    );

    // Step 3 — homography + pose. `table.detection.boundary` is the OUTER
    // rail edge (cloth segmentation can't tell it apart from the cushion nose
    // by colour — see `CUSHION_WIDTH_MM`'s doc), so it's passed as such here;
    // the resulting frame's own (0,0)..(widthMm,heightMm) is the corrected
    // nose line, exactly as every downstream consumer already assumes.
    const frame = clock('buildFrame', () =>
      buildTableFrame(
        table.detection.boundary,
        settings.tableSize,
        image.width,
        image.height,
        undefined,
        cushionWidthMm,
      )
    );
    // Nose-line corners in image pixels, for the confirm screen (§PixelDetection).
    const noseBoundaryPx = rectifiedBoundary(frame.widthMm, frame.heightMm).map((p) =>
      projectTablePoint(frame, p, 0),
    ) as [Point, Point, Point, Point];

    // Step 4 — ball blobs.
    const detection = clock('detectBalls', () =>
      detectBalls(
        cv,
        segmentation.mask,
        segmentation.rgb,
        image,
        frame,
        table.detection.boundary,
        ballRadiusMm,
        segmentation.estimate.hue
      )
    );

    const warnings = [...table.warnings];
    const chosen = detection.candidates.slice(0, 4);
    if (chosen.length < 4) {
      throw new Error(
        `Found ${chosen.length} ball(s), expected 4. ` +
          (detection.rejected.length > 0
            ? `Rejected ${detection.rejected.length} blob(s): ` +
              detection.rejected
                .slice(0, 5)
                .map((r) => r.reason)
                .join('; ')
            : 'No further blob candidates were found inside the table.')
      );
    }
    if (detection.candidates.length > 4) {
      warnings.push(
        `${detection.candidates.length} ball-like blobs found; kept the 4 highest-scoring. ` +
          'A cue tip, chalk cube or a ball from a neighbouring table may be in frame.'
      );
    }

    // Step 5 — relative colour classification.
    const assignment = clock('classifyColors', () =>
      classifyBallColors(chosen.map((c) => c.rgb))
    );

    // Step 4 (cont.) — mm positions WITH the z=radius parallax correction.
    const balls: Ball[] = [];
    const pixelBalls: PixelDetection['balls'] = [];
    const parallaxCorrectionMm: number[] = [];

    const colorOrder: BallColor[] = ['white', 'yellow', 'red1', 'red2'];
    for (const color of colorOrder) {
      const candidate = chosen[assignment.indices[color]];
      const corrected = ballImagePointToTableMm(frame, candidate.center, ballRadiusMm);
      parallaxCorrectionMm.push(parallaxMagnitudeMm(frame, candidate.center, corrected));

      const role = roleFor(color, settings.cueBallColor);
      const id = BALL_IDS[color];
      balls.push({ id, color, role, position: corrected });
      pixelBalls.push({
        id,
        color,
        role,
        x: candidate.center.x,
        y: candidate.center.y,
        radiusPx: candidate.radiusPx,
      });
    }

    // Step 6 — confidence.
    const dims = TABLE_DIMENSIONS_MM[settings.tableSize];
    const breakdown = scoreConfidence({
      // Corner-extrapolation error estimates are folded in alongside the
      // per-side RMS values, not scored separately — `scoreTableFit` just
      // takes the worst of whatever pixel-error signals it's handed, and a
      // badly-extrapolated corner (table.ts#cornerExtrapolationErrorPx) is
      // exactly that kind of signal: a corner can be wrong even when every
      // individual side's own RMS looks fine.
      sideResidualsPx: [...table.sides.map((s) => s.rmsResidual), ...table.cornerExtrapolationErrorPx],
      imageDiagonalPx: Math.hypot(image.width, image.height),
      rectangleConsistency: frame.rectangleConsistency,
      ballsFound: chosen.length,
      meanBallScore: chosen.reduce((a, c) => a + c.score, 0) / chosen.length,
      colorMargin: assignment.margin,
      cameraHeightMm: frame.pose.centerMm.z,
      focalWasMeasured: frame.pose.intrinsics.source !== 'assumed',
      radiusScaleCorrection: detection.radiusScaleCorrection,
    });

    if (table.cornersOutOfFrame > 0) {
      warnings.push(
        `${table.cornersOutOfFrame} table corner(s) fell outside the frame and were ` +
          'extrapolated from the fitted cushion lines.'
      );
    }

    const recognition: RecognitionResult = {
      table: {
        boundary: rectifiedBoundary(dims.widthMm, dims.heightMm),
        size: settings.tableSize,
      },
      balls,
      confidence: breakdown.overall,
      needsManualCorrection: needsManualCorrection(breakdown.overall, threshold),
    };

    return {
      recognition,
      pixelDetection: {
        imageWidth: image.width,
        imageHeight: image.height,
        tableBoundary: noseBoundaryPx,
        outerTableBoundary: table.detection.boundary,
        balls: pixelBalls,
      },
      diagnostics: {
        confidence: breakdown,
        cloth: segmentation.estimate,
        focalPx: frame.pose.intrinsics.focalPx,
        focalSource: frame.pose.intrinsics.source,
        cameraCenterMm: frame.pose.centerMm,
        parallaxCorrectionMm,
        cornersOutOfFrame: table.cornersOutOfFrame,
        observedAspectRatio: table.observedAspectRatio,
        ballCandidatesConsidered: detection.candidates.length,
        colorRationale: assignment.rationale,
        warnings,
        timingsMs,
      },
    };
  } finally {
    disposeSegmentation(segmentation);
  }
}

function roleFor(color: BallColor, cueBallColor: Settings['cueBallColor']): BallRole {
  if (color === 'red1' || color === 'red2') return 'targetBall';
  return color === cueBallColor ? 'cueBall' : 'opponentBall';
}

/**
 * How far the parallax correction moved this ball, in mm — i.e. the error that
 * would have been shipped by naively using the cloth-plane homography.
 */
function parallaxMagnitudeMm(frame: TableFrame, imagePoint: Vec2, corrected: Point): number {
  const onCloth = applyImageToTable(frame, imagePoint);
  return Math.hypot(corrected.x - onCloth.x, corrected.y - onCloth.y);
}

function applyImageToTable(frame: TableFrame, p: Vec2): Point {
  const h = frame.imageToTable;
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

export type { BallCandidate };
