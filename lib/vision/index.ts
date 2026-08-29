/**
 * Public surface of the Vision Recognition module.
 *
 * Consumers (the `/api/recognize` route, the geometric-gate harness, tests)
 * should import from here rather than reaching into individual files, so the
 * internal split between segmentation / line fitting / pose / blobs stays free
 * to change.
 */

export { recognize } from './pipeline';
export type {
  PixelDetection,
  RecognizeDiagnostics,
  RecognizeOptions,
  RecognizeOutput,
} from './pipeline';

export {
  BALL_DIAMETER_MM,
  BALL_RADIUS_MM,
  CONFIDENCE_THRESHOLD,
  MAX_IMAGE_DIMENSION,
} from './constants';

export { decodeImage, downscaleToMaxDimension, encodePng } from './image';
export type { RgbaImage } from './image';

export { classifyBallColors, colorFeatures } from './balls';
export type { BallCandidate, ColorAssignment, ColorFeatures } from './balls';

export { needsManualCorrection, scoreConfidence } from './confidence';
export type { ConfidenceBreakdown, ConfidenceInputs } from './confidence';

export {
  ballImagePointToTableMm,
  buildTableFrame,
  computeHomography,
  estimateIntrinsics,
  localMmPerPixel,
  projectTablePoint,
  recoverCameraPose,
  reprojectToBallPlane,
  tableRectMm,
} from './camera';
export type { CameraPose, Intrinsics, TableFrame } from './camera';

export { detectTableBoundary, quadAspectRatio, rectifiedBoundary } from './table';
export type { SideFit, TableDetectionResult } from './table';

export { SYNTHETIC_BALL_RGB, renderSyntheticScene } from './synthetic';
export type { SyntheticScene, SyntheticSceneSpec } from './synthetic';
