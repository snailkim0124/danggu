/**
 * Synthetic billiard-table renderer — a camera simulator for testing.
 *
 * Why this exists: the geometric gate needs photos with *exactly* known ball
 * positions, and hand-measuring a real table to sub-millimetre truth is the
 * user's job and hasn't happened yet (plan Phase 5). A forward renderer gives
 * ground truth for free: we place balls at chosen mm coordinates, project them
 * through a known camera, and the recognition pipeline has to recover those
 * same coordinates. That closes the loop on the parts most likely to be
 * silently wrong — the homography, the pose, and above all the z=radius
 * parallax correction, whose whole effect is a systematic offset that no
 * self-consistency check inside the pipeline could ever notice.
 *
 * What it is NOT: a substitute for real photos. It renders clean, evenly-lit
 * geometry with hard-edged balls, so it cannot exercise motion blur, specular
 * glare across the cloth, ball-on-ball occlusion, or the colour drift of real
 * hall lighting. Passing here is necessary, not sufficient.
 *
 * The renderer deliberately includes cast shadows, sensor noise and a cushion
 * rail, because those are the three things that most affect blob extraction —
 * shadows bias the ball centre, noise widens the cloth-hue window, and the
 * rail is what the cushion-line fit has to *avoid* latching onto.
 */

import { TABLE_DIMENSIONS_MM, type Point, type TableSize } from '@/lib/types';
import { BALL_RADIUS_MM } from './constants';
import { type RgbaImage, createRgbaImage } from './image';

export interface SyntheticCamera {
  /** Camera position in table mm coordinates (z = height above cloth). */
  positionMm: { x: number; y: number; z: number };
  /** Point on the table the camera looks at, in mm (z = 0). */
  lookAtMm: Point;
  /** Focal length in pixels. */
  focalPx: number;
}

export interface SyntheticBall {
  /** Ball centre, in table mm coordinates (the z=radius plane). */
  positionMm: Point;
  rgb: [number, number, number];
}

export interface SyntheticSceneSpec {
  tableSize: TableSize;
  imageWidth: number;
  imageHeight: number;
  camera: SyntheticCamera;
  balls: SyntheticBall[];
  ballRadiusMm?: number;
  /** Std-dev of per-channel Gaussian sensor noise, 0..255. */
  noise?: number;
  /** Deterministic PRNG seed, so fixtures are byte-reproducible. */
  seed?: number;
  clothRgb?: [number, number, number];
  railRgb?: [number, number, number];
  backgroundRgb?: [number, number, number];
  /** Width of the visible rail band beyond the cushion nose line, in mm. */
  railWidthMm?: number;
  /**
   * Width (mm) of a cushion band, cloth-coloured just like the bed, between
   * the cushion-nose line and the `railRgb` band. `0` (default) renders the
   * simpler case where cloth ends exactly at the nose line — useful for
   * isolating unrelated behaviour, but not what a real table looks like: real
   * cushions are covered in the same cloth as the bed, which is exactly why
   * `detectTableBoundary` cannot find the nose line by colour alone (see
   * `lib/vision/constants.ts#CUSHION_WIDTH_MM`). Set this to reproduce that
   * and exercise the pipeline's `cushionWidthMm` correction end-to-end.
   */
  cushionWidthMm?: number;
}

export interface SyntheticScene {
  image: RgbaImage;
  /** Ground-truth ball centres in table mm coordinates. */
  ballPositionsMm: Point[];
  /** Ground-truth cushion-nose corners in table mm coordinates. */
  tableCornersMm: [Point, Point, Point, Point];
  /** Ground-truth cushion-nose corners projected into image pixels. */
  tableCornersPx: Array<{ x: number; y: number }>;
  /** Ground-truth ball centres projected into image pixels. */
  ballCentersPx: Array<{ x: number; y: number }>;
  ballRadiusMm: number;
}

type Vec3 = [number, number, number];

/** Standard carom colours, close enough to real balls for classification tests. */
export const SYNTHETIC_BALL_RGB = {
  white: [236, 233, 224] as [number, number, number],
  yellow: [226, 186, 38] as [number, number, number],
  red: [182, 38, 34] as [number, number, number],
};

export function renderSyntheticScene(spec: SyntheticSceneSpec): SyntheticScene {
  const {
    tableSize,
    imageWidth,
    imageHeight,
    camera,
    balls,
    ballRadiusMm = BALL_RADIUS_MM,
    noise = 3,
    seed = 1,
    clothRgb = [26, 108, 80],
    railRgb = [86, 58, 38],
    backgroundRgb = [24, 24, 28],
    railWidthMm = 90,
    cushionWidthMm = 0,
  } = spec;

  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[tableSize];
  const { rotation, translation } = lookAtPose(camera);
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const f = camera.focalPx;
  const C: Vec3 = [camera.positionMm.x, camera.positionMm.y, camera.positionMm.z];

  const project = (p: Vec3): { x: number; y: number; depth: number } => {
    const xc = rotation[0] * p[0] + rotation[1] * p[1] + rotation[2] * p[2] + translation[0];
    const yc = rotation[3] * p[0] + rotation[4] * p[1] + rotation[5] * p[2] + translation[1];
    const zc = rotation[6] * p[0] + rotation[7] * p[1] + rotation[8] * p[2] + translation[2];
    return { x: (f * xc) / zc + cx, y: (f * yc) / zc + cy, depth: zc };
  };

  const image = createRgbaImage(imageWidth, imageHeight);
  const rand = mulberry32(seed);

  // --- Background pass: ray-cast each pixel onto the cloth plane -----------
  // Rᵀ maps a camera-frame direction back into table coordinates.
  const rt = [
    rotation[0], rotation[3], rotation[6],
    rotation[1], rotation[4], rotation[7],
    rotation[2], rotation[5], rotation[8],
  ];

  // Depth of the cloth under each pixel, so balls can be depth-composited.
  const clothDepth = new Float32Array(imageWidth * imageHeight);

  for (let py = 0; py < imageHeight; py++) {
    for (let px = 0; px < imageWidth; px++) {
      const dCam: Vec3 = [(px + 0.5 - cx) / f, (py + 0.5 - cy) / f, 1];
      const d: Vec3 = [
        rt[0] * dCam[0] + rt[1] * dCam[1] + rt[2] * dCam[2],
        rt[3] * dCam[0] + rt[4] * dCam[1] + rt[5] * dCam[2],
        rt[6] * dCam[0] + rt[7] * dCam[1] + rt[8] * dCam[2],
      ];
      const idx = py * imageWidth + px;
      let color = backgroundRgb;
      clothDepth[idx] = Infinity;

      if (d[2] < -1e-9) {
        const t = -C[2] / d[2];
        const wx = C[0] + t * d[0];
        const wy = C[1] + t * d[1];
        const inTable = wx >= 0 && wx <= widthMm && wy >= 0 && wy <= heightMm;
        const inCushion =
          wx >= -cushionWidthMm &&
          wx <= widthMm + cushionWidthMm &&
          wy >= -cushionWidthMm &&
          wy <= heightMm + cushionWidthMm;
        const railOuterMm = cushionWidthMm + railWidthMm;
        const inRail =
          wx >= -railOuterMm && wx <= widthMm + railOuterMm && wy >= -railOuterMm && wy <= heightMm + railOuterMm;
        if (inTable) {
          color = clothRgb;
          clothDepth[idx] = t; // ray parameter is monotonic in depth
        } else if (inCushion) {
          // Same colour as the bed on purpose — see `cushionWidthMm`'s doc.
          // Left out of `clothDepth` (which stays `Infinity` here): this band
          // is the raised cushion face, not the flat bed, so a ball is never
          // actually behind it the way it can be behind bed cloth.
          color = clothRgb;
        } else if (inRail) {
          color = railRgb;
        }
      }
      writePixel(image, idx, color, noise, rand);
    }
  }

  // --- Shadow pass ---------------------------------------------------------
  // A soft ellipse under each ball, offset from the ball's image centre.
  // Present on purpose: it is what makes a naive blob centroid wrong, so the
  // robust circle fit has something real to reject.
  for (const ball of balls) {
    // The shadow lies flat on the cloth, so its image shape is the projection
    // of a *ground-plane* disc — an ellipse whose axes follow the same
    // foreshortening as the cloth, not a circle scaled by depth. Drawing it as
    // a circle (as an earlier version did) makes far-field shadows several
    // times larger than the ball they belong to, which is not what a real
    // photo looks like and makes the fixtures unfairly hard.
    const g0 = project([ball.positionMm.x, ball.positionMm.y, 0]);
    const gx = project([ball.positionMm.x + ballRadiusMm * 1.1, ball.positionMm.y, 0]);
    const gy = project([ball.positionMm.x, ball.positionMm.y + ballRadiusMm * 1.1, 0]);
    stampSoftEllipseAxes(
      image,
      // Offset the shadow slightly, as a light that is not exactly overhead
      // would — this is what biases a naive blob centroid.
      g0.x + (gx.x - g0.x) * 0.25 + (gy.x - g0.x) * 0.25,
      g0.y + (gx.y - g0.y) * 0.25 + (gy.y - g0.y) * 0.25,
      gx.x - g0.x,
      gx.y - g0.y,
      gy.x - g0.x,
      gy.y - g0.y,
      0.45
    );
  }

  // --- Ball pass, far to near ---------------------------------------------
  const ballCentersPx: Array<{ x: number; y: number }> = [];
  const projected = balls.map((ball) => {
    const p = project([ball.positionMm.x, ball.positionMm.y, ballRadiusMm]);
    return { ball, p };
  });
  for (const { p } of projected) ballCentersPx.push({ x: p.x, y: p.y });

  for (const { ball, p } of [...projected].sort((a, b) => b.p.depth - a.p.depth)) {
    const rPx = (ballRadiusMm * f) / p.depth;
    drawShadedSphere(image, p.x, p.y, rPx, p.depth, ball.rgb, clothDepth, noise, rand);
  }

  const tableCornersMm: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];

  return {
    image,
    ballPositionsMm: balls.map((b) => ({ ...b.positionMm })),
    tableCornersMm,
    tableCornersPx: tableCornersMm.map((c) => {
      const q = project([c.x, c.y, 0]);
      return { x: q.x, y: q.y };
    }),
    ballCentersPx,
    ballRadiusMm,
  };
}

/**
 * Build the table→camera rotation/translation for a look-at camera, using the
 * image convention x right, y down, z forward (the same convention
 * `camera.ts` recovers).
 */
export function lookAtPose(camera: SyntheticCamera): {
  rotation: number[];
  translation: Vec3;
} {
  const C: Vec3 = [camera.positionMm.x, camera.positionMm.y, camera.positionMm.z];
  const target: Vec3 = [camera.lookAtMm.x, camera.lookAtMm.y, 0];
  const zc = normalize([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  // x = z × up puts image-x to the camera's right; y = z × x then points down
  // in the scene, matching an image whose y axis grows downwards.
  //
  // A camera looking straight down is parallel to the up vector, so that cross
  // product vanishes and the camera's roll is genuinely undefined. Any roll is
  // a valid answer there; pick the table's x axis as the reference so a
  // top-down rig still produces a well-formed pose instead of a zero matrix.
  const upRef: Vec3 = Math.abs(zc[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  const xc = normalize(cross(zc, upRef));
  const yc = cross(zc, xc);

  // Rows of R are the camera axes expressed in table coordinates.
  const rotation = [xc[0], xc[1], xc[2], yc[0], yc[1], yc[2], zc[0], zc[1], zc[2]];
  const translation: Vec3 = [
    -(rotation[0] * C[0] + rotation[1] * C[1] + rotation[2] * C[2]),
    -(rotation[3] * C[0] + rotation[4] * C[1] + rotation[5] * C[2]),
    -(rotation[6] * C[0] + rotation[7] * C[1] + rotation[8] * C[2]),
  ];
  return { rotation, translation };
}

// ---------------------------------------------------------------------------
// Raster helpers
// ---------------------------------------------------------------------------

function writePixel(
  image: RgbaImage,
  idx: number,
  rgb: readonly [number, number, number] | number[],
  noise: number,
  rand: () => number
): void {
  const o = idx * 4;
  image.data[o] = rgb[0] + gaussian(rand) * noise;
  image.data[o + 1] = rgb[1] + gaussian(rand) * noise;
  image.data[o + 2] = rgb[2] + gaussian(rand) * noise;
  image.data[o + 3] = 255;
}

/**
 * Darken a soft ellipse defined by two (not necessarily perpendicular) axis
 * vectors `a` and `b` from its centre — i.e. the image of a unit disc under
 * the affine map `[a b]`. This is what a ground-plane circle looks like after
 * projection, unlike an axis-aligned rx/ry ellipse.
 */
function stampSoftEllipseAxes(
  image: RgbaImage,
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  strength: number
): void {
  const det = ax * by - ay * bx;
  if (Math.abs(det) < 1e-9) return;
  // Inverse of [[ax, bx], [ay, by]], mapping image offsets into disc space.
  const i00 = by / det;
  const i01 = -bx / det;
  const i10 = -ay / det;
  const i11 = ax / det;

  const spanX = Math.abs(ax) + Math.abs(bx);
  const spanY = Math.abs(ay) + Math.abs(by);
  const x0 = Math.max(0, Math.floor(cx - spanX));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + spanX));
  const y0 = Math.max(0, Math.floor(cy - spanY));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + spanY));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = i00 * dx + i01 * dy;
      const v = i10 * dx + i11 * dy;
      const d2 = u * u + v * v;
      if (d2 > 1) continue;
      const k = 1 - strength * (1 - d2) ** 0.7;
      const o = (y * image.width + x) * 4;
      image.data[o] *= k;
      image.data[o + 1] *= k;
      image.data[o + 2] *= k;
    }
  }
}

function drawShadedSphere(
  image: RgbaImage,
  cx: number,
  cy: number,
  r: number,
  depth: number,
  rgb: readonly [number, number, number],
  clothDepth: Float32Array,
  noise: number,
  rand: () => number
): void {
  if (!(r > 0.5)) return;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + r + 1));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dy = (y + 0.5 - cy) / r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const idx = y * image.width + x;
      // The ball is only visible where it is in front of the cloth behind it.
      if (!(depth < clothDepth[idx] * 1e9)) continue;

      // Lambert-ish shading from an overhead-left key light, plus a small
      // specular lobe — the highlight is why ball colour is sampled with a
      // median rather than a mean.
      const nz = Math.sqrt(Math.max(0, 1 - d2));
      const lambert = 0.55 + 0.45 * clamp01(-dx * 0.35 - dy * 0.5 + nz * 0.8);
      const spec = Math.pow(clamp01(1 - Math.hypot(dx + 0.32, dy + 0.38) * 2.1), 2.5) * 90;

      // Antialias the silhouette so the fitted radius isn't quantised.
      const edge = clamp01((1 - Math.sqrt(d2)) * r * 1.2);
      const o = idx * 4;
      const shade = (c: number) => clamp255(c * lambert + spec + gaussian(rand) * noise);
      image.data[o] = mix(image.data[o], shade(rgb[0]), edge);
      image.data[o + 1] = mix(image.data[o + 1], shade(rgb[1]), edge);
      image.data[o + 2] = mix(image.data[o + 2], shade(rgb[2]), edge);
    }
  }
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Small deterministic PRNG — fixtures must be byte-reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, one sample per call (the discarded second sample is not worth
 * the state-keeping at this scale). */
function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
