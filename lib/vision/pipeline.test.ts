/**
 * @vitest-environment node
 *
 * The pipeline is server-side (OpenCV.js WASM + Node APIs), so it is tested
 * in the Node environment rather than the project-wide jsdom default.
 */
import { describe, expect, it } from 'vitest';
import type { Point, Settings } from '@/lib/types';
import { recognize } from './pipeline';
import { SYNTHETIC_BALL_RGB, renderSyntheticScene, type SyntheticScene } from './synthetic';
import { BALL_RADIUS_MM, CUSHION_WIDTH_MM } from './constants';

/**
 * End-to-end tests: render a table with known ball positions, hand the pixels
 * to `recognize`, and check the recovered millimetre coordinates against the
 * positions we rendered from.
 *
 * This is the same measurement the geometric gate makes (`scripts/geometric-gate.ts`),
 * just with synthetic ground truth instead of hand-measured photos. It exists
 * to catch regressions in the *whole chain* — segmentation, line fitting,
 * homography, pose and parallax — which the unit tests can only cover in
 * isolation.
 *
 * These load and run OpenCV.js (WASM), so they are slower than the pure-maths
 * tests; the timeout is raised accordingly.
 */

const TIMEOUT_MS = 60_000;

const SETTINGS: Settings = { cueBallColor: 'white', tableSize: '대대' };

const BASE_WIDTH = 1280;
const BASE_FOCAL = 1050;

function scene(overrides: Partial<Parameters<typeof renderSyntheticScene>[0]> = {}): SyntheticScene {
  // Rendering at a different resolution must not change the field of view, or
  // a "does downscaling work" test would silently become a "does a different
  // lens work" test.
  const width = overrides.imageWidth ?? BASE_WIDTH;
  const camera = {
    positionMm: { x: -1250, y: 635, z: 1500 },
    lookAtMm: { x: 1270, y: 635 },
    focalPx: (BASE_FOCAL * width) / BASE_WIDTH,
    ...(overrides.camera ?? {}),
  };
  return renderSyntheticScene({
    tableSize: '대대',
    imageWidth: BASE_WIDTH,
    imageHeight: 960,
    balls: [
      { positionMm: { x: 640, y: 420 }, rgb: SYNTHETIC_BALL_RGB.white },
      { positionMm: { x: 1550, y: 880 }, rgb: SYNTHETIC_BALL_RGB.yellow },
      { positionMm: { x: 1980, y: 380 }, rgb: SYNTHETIC_BALL_RGB.red },
      { positionMm: { x: 900, y: 950 }, rgb: SYNTHETIC_BALL_RGB.red },
    ],
    seed: 7,
    // Cloth-coloured cushions, exactly like a real table (see
    // `CUSHION_WIDTH_MM`'s doc) — `recognize`'s own default cushion-width
    // correction is what has to see through this to recover the true
    // cushion-nose corners, not the visually-merged outer edge.
    cushionWidthMm: CUSHION_WIDTH_MM,
    ...overrides,
    // A realistic player's-eye view: standing off one end, phone at chest
    // height, the whole table in shot. Every cushion is at least partly
    // visible, which is the precondition the four-line fit needs.
    camera,
  });
}

/** RMS error, in mm, between recovered and ground-truth ball positions. */
function rmsErrorMm(recovered: Point[], truth: Point[]): number {
  expect(recovered).toHaveLength(truth.length);
  let sse = 0;
  for (let i = 0; i < truth.length; i++) {
    sse += (recovered[i].x - truth[i].x) ** 2 + (recovered[i].y - truth[i].y) ** 2;
  }
  return Math.sqrt(sse / truth.length);
}

describe('recognize (end to end on a rendered table)', () => {
  it(
    'recovers ball positions to within the 8mm geometric gate',
    async () => {
      const s = scene();
      const { recognition, diagnostics } = await recognize(s.image, SETTINGS);

      // Ground truth is ordered white, yellow, red, red — line the recovered
      // balls up by colour rather than by detection order.
      const byColor = new Map(recognition.balls.map((b) => [b.color, b.position]));
      const recovered = [
        byColor.get('white')!,
        byColor.get('yellow')!,
        byColor.get('red1')!,
        byColor.get('red2')!,
      ];
      // The two reds are interchangeable; pair each to its nearest truth.
      const truth = [...s.ballPositionsMm];
      const redTruth = [truth[2], truth[3]];
      const orderedTruth = [
        truth[0],
        truth[1],
        ...nearestPairing([recovered[2], recovered[3]], redTruth),
      ];

      const rms = rmsErrorMm(recovered, orderedTruth);
      expect(rms, `RMS ${rms.toFixed(2)}mm; diagnostics ${JSON.stringify(diagnostics)}`).toBeLessThan(8);
    },
    TIMEOUT_MS
  );

  it(
    'classifies white, yellow and the two reds correctly',
    async () => {
      const { recognition } = await recognize(scene().image, SETTINGS);
      const colors = recognition.balls.map((b) => b.color).sort();
      expect(colors).toEqual(['red1', 'red2', 'white', 'yellow']);

      // Roles follow the user's cue-ball setting, not the ball's colour alone.
      const byColor = new Map(recognition.balls.map((b) => [b.color, b.role]));
      expect(byColor.get('white')).toBe('cueBall');
      expect(byColor.get('yellow')).toBe('opponentBall');
      expect(byColor.get('red1')).toBe('targetBall');
      expect(byColor.get('red2')).toBe('targetBall');
    },
    TIMEOUT_MS
  );

  it(
    'swaps cue/opponent roles when the user plays yellow',
    async () => {
      const { recognition } = await recognize(scene().image, {
        cueBallColor: 'yellow',
        tableSize: '대대',
      });
      const byColor = new Map(recognition.balls.map((b) => [b.color, b.role]));
      expect(byColor.get('yellow')).toBe('cueBall');
      expect(byColor.get('white')).toBe('opponentBall');
    },
    TIMEOUT_MS
  );

  it(
    'applies a parallax correction of the magnitude the plan predicts',
    async () => {
      const { diagnostics } = await recognize(scene().image, SETTINGS);
      // Every ball must actually have been moved — a zero here would mean the
      // z=radius reprojection silently became a no-op.
      for (const mm of diagnostics.parallaxCorrectionMm) {
        expect(mm).toBeGreaterThan(5);
      }
      // ...and the far balls should land in the tens of millimetres.
      expect(Math.max(...diagnostics.parallaxCorrectionMm)).toBeGreaterThan(25);
    },
    TIMEOUT_MS
  );

  it(
    'recovers the camera pose close to where the scene was rendered from',
    async () => {
      const { diagnostics } = await recognize(scene().image, SETTINGS);
      expect(diagnostics.cameraCenterMm.z).toBeGreaterThan(1250);
      expect(diagnostics.cameraCenterMm.z).toBeLessThan(1800);
      expect(diagnostics.focalSource).toBe('measured');
    },
    TIMEOUT_MS
  );

  it(
    'reports high confidence and no manual correction for a clean scene',
    async () => {
      const { recognition, diagnostics } = await recognize(scene().image, SETTINGS);
      expect(
        recognition.confidence,
        `breakdown ${JSON.stringify(diagnostics.confidence)}`
      ).toBeGreaterThan(0.6);
      expect(recognition.needsManualCorrection).toBe(false);
    },
    TIMEOUT_MS
  );

  it(
    'returns pixel-space detections aligned with the rendered geometry',
    async () => {
      const s = scene();
      const { pixelDetection } = await recognize(s.image, SETTINGS);

      expect(pixelDetection.imageWidth).toBe(s.image.width);
      expect(pixelDetection.imageHeight).toBe(s.image.height);
      expect(pixelDetection.balls).toHaveLength(4);

      // Detected table corners must land near where the renderer put them.
      // `tableBoundary` is documented as clockwise-in-image starting from the
      // corner nearest the image origin, which is not required to line up with
      // the mm rectangle's corner order, so match each corner to its nearest
      // ground-truth counterpart rather than by index.
      for (const got of pixelDetection.tableBoundary) {
        const best = Math.min(
          ...s.tableCornersPx.map((want) => Math.hypot(got.x - want.x, got.y - want.y))
        );
        expect(best).toBeLessThan(12);
      }

      // Every detected ball centre must be close to a rendered ball centre.
      for (const ball of pixelDetection.balls) {
        const best = Math.min(
          ...s.ballCentersPx.map((c) => Math.hypot(c.x - ball.x, c.y - ball.y))
        );
        expect(best).toBeLessThan(6);
        expect(ball.radiusPx).toBeGreaterThan(2);
      }
    },
    TIMEOUT_MS
  );

  it(
    'still recovers the table when a corner is cropped out of frame',
    async () => {
      // Camera pushed closer and tilted so the two near corners fall outside
      // the frame while all four cushion edges remain partly visible — exactly
      // the case the four-line fit exists for (plan Table.boundary: "모서리가
      // 프레임 밖으로 잘려도 복원 가능").
      const s = scene({
        camera: {
          positionMm: { x: -1000, y: 200, z: 1400 },
          lookAtMm: { x: 1270, y: 700 },
          focalPx: 1250,
        },
      });
      const { recognition, diagnostics } = await recognize(s.image, SETTINGS);
      expect(
        diagnostics.cornersOutOfFrame,
        `expected extrapolated corners; diagnostics ${JSON.stringify(diagnostics)}`
      ).toBeGreaterThan(0);
      expect(recognition.balls).toHaveLength(4);
      // The extrapolated corners must still be good enough to locate balls.
      expect(diagnostics.cameraCenterMm.z).toBeGreaterThan(500);
    },
    TIMEOUT_MS
  );

  it(
    'recovers both balls when two are frozen touching each other',
    async () => {
      // Two balls placed exactly tangent (centre-to-centre = one ball
      // diameter) — the same "공이 붙어있는" case a real photo can produce,
      // which used to always be rejected as a single oversized, non-circular
      // merged blob (see balls.ts#trySplitMergedBlob).
      // The default `scene()` camera frames the *whole* table from one end,
      // which renders each ball only ~11px in radius — too small at any
      // camera-angle for a Hough fit to resolve two touching balls' rims
      // apart, regardless of tuning (verified while building this test).
      // Realistic phone photos are very often closer than that (standing
      // over the table, or a partial-table close-up), so this uses a nearer
      // camera giving each ball a plausible ~25px radius instead.
      const touchGap = BALL_RADIUS_MM * 2;
      const s = scene({
        imageWidth: 1600,
        imageHeight: 1200,
        balls: [
          { positionMm: { x: 2100, y: 950 }, rgb: SYNTHETIC_BALL_RGB.white },
          { positionMm: { x: 1900, y: 300 }, rgb: SYNTHETIC_BALL_RGB.red },
          { positionMm: { x: 350, y: 500 }, rgb: SYNTHETIC_BALL_RGB.yellow },
          { positionMm: { x: 350 + touchGap, y: 500 }, rgb: SYNTHETIC_BALL_RGB.red },
        ],
      });
      const { recognition, diagnostics } = await recognize(s.image, SETTINGS);
      expect(recognition.balls, `diagnostics ${JSON.stringify(diagnostics)}`).toHaveLength(4);

      // Touching balls are a genuinely harder case (each occludes part of the
      // other's rim), so allow a looser tolerance than the standard 8mm
      // geometric gate — the point of this test is "found and roughly
      // right", not full geometric-gate precision.
      const truth = s.ballPositionsMm;
      for (const ball of recognition.balls) {
        const nearest = Math.min(
          ...truth.map((t) => Math.hypot(t.x - ball.position.x, t.y - ball.position.y))
        );
        expect(
          nearest,
          `${ball.color} recovered at (${ball.position.x.toFixed(0)}, ${ball.position.y.toFixed(0)})`
        ).toBeLessThan(25);
      }
    },
    TIMEOUT_MS
  );

  it(
    'downscales oversized input before processing',
    async () => {
      const s = scene({ imageWidth: 2400, imageHeight: 1800 });
      const { pixelDetection } = await recognize(s.image, SETTINGS, { maxDimension: 1000 });
      expect(Math.max(pixelDetection.imageWidth, pixelDetection.imageHeight)).toBe(1000);
    },
    TIMEOUT_MS
  );

  it(
    'reports a helpful error rather than a crash when there is no table',
    async () => {
      const blank = {
        width: 320,
        height: 240,
        data: new Uint8ClampedArray(320 * 240 * 4).fill(200),
      };
      await expect(recognize(blank, SETTINGS)).rejects.toThrow();
    },
    TIMEOUT_MS
  );
});

/** Pair each recovered red to its closest ground-truth red. */
function nearestPairing(recovered: Point[], truth: Point[]): Point[] {
  const direct =
    dist(recovered[0], truth[0]) + dist(recovered[1], truth[1]);
  const swapped =
    dist(recovered[0], truth[1]) + dist(recovered[1], truth[0]);
  return direct <= swapped ? truth : [truth[1], truth[0]];
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('synthetic renderer sanity', () => {
  it('places balls on the z=radius plane, not the cloth', () => {
    const s = scene();
    expect(s.ballRadiusMm).toBeCloseTo(BALL_RADIUS_MM, 6);
    // A ball's rendered centre must differ from where its cloth-plane
    // footprint would project, or the fixtures could not test parallax at all.
    for (let i = 0; i < s.ballCentersPx.length; i++) {
      expect(s.ballCentersPx[i].y).toBeLessThan(s.image.height);
      expect(s.ballCentersPx[i].y).toBeGreaterThan(0);
    }
  });
});
