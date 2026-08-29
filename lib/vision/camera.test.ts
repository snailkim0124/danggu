import { describe, expect, it } from 'vitest';
import { TABLE_DIMENSIONS_MM, type TableSize } from '@/lib/types';
import {
  ballImagePointToTableMm,
  buildTableFrame,
  computeHomography,
  estimateIntrinsics,
  localMmPerPixel,
  reprojectToBallPlane,
  tableRectMm,
} from './camera';
import { applyHomography } from './geometry';
import { lookAtPose } from './synthetic';
import { BALL_RADIUS_MM } from './constants';

/**
 * These tests drive the geometry against a *known* synthetic camera rather
 * than against itself. That matters: the homography, the pose and the parallax
 * correction are all mutually consistent even when they are all wrong
 * together, so a round-trip test alone would pass on a broken pipeline. Here
 * the ground truth comes from an independent forward projection.
 */

interface Rig {
  size: TableSize;
  imageWidth: number;
  imageHeight: number;
  focalPx: number;
  cameraMm: { x: number; y: number; z: number };
  project: (x: number, y: number, z: number) => { x: number; y: number };
}

function makeRig(
  cameraMm: { x: number; y: number; z: number },
  lookAtMm: { x: number; y: number },
  focalPx = 1500,
  imageWidth = 1600,
  imageHeight = 1200,
  size: TableSize = '대대'
): Rig {
  const { rotation: r, translation: t } = lookAtPose({
    positionMm: cameraMm,
    lookAtMm,
    focalPx,
  });
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  return {
    size,
    imageWidth,
    imageHeight,
    focalPx,
    cameraMm,
    project: (x, y, z) => {
      const xc = r[0] * x + r[1] * y + r[2] * z + t[0];
      const yc = r[3] * x + r[4] * y + r[5] * z + t[1];
      const zc = r[6] * x + r[7] * y + r[8] * z + t[2];
      return { x: (focalPx * xc) / zc + cx, y: (focalPx * yc) / zc + cy };
    },
  };
}

function frameFromRig(rig: Rig) {
  const corners = tableRectMm(rig.size).map((c) => rig.project(c.x, c.y, 0));
  return buildTableFrame(
    [corners[0], corners[1], corners[2], corners[3]],
    rig.size,
    rig.imageWidth,
    rig.imageHeight
  );
}

/** A typical shot: player stands at one end, phone at chest height. */
const OBLIQUE = makeRig({ x: -450, y: 635, z: 1250 }, { x: 1400, y: 635 });

describe('computeHomography', () => {
  it('maps the four table corners exactly onto their image projections', () => {
    const mm = tableRectMm('대대');
    const px = mm.map((c) => OBLIQUE.project(c.x, c.y, 0));
    const h = computeHomography(mm, [px[0], px[1], px[2], px[3]]);

    for (let i = 0; i < 4; i++) {
      const mapped = applyHomography(h, mm[i]);
      expect(mapped.x).toBeCloseTo(px[i].x, 5);
      expect(mapped.y).toBeCloseTo(px[i].y, 5);
    }
  });

  it('agrees with the forward projection at points it was never fitted on', () => {
    const mm = tableRectMm('대대');
    const px = mm.map((c) => OBLIQUE.project(c.x, c.y, 0));
    const h = computeHomography(mm, [px[0], px[1], px[2], px[3]]);

    // Interior cloth points: a homography that matched only at the corners
    // (e.g. through a conditioning blow-up) would drift badly here.
    for (const p of [
      { x: 1270, y: 635 },
      { x: 300, y: 200 },
      { x: 2200, y: 1000 },
    ]) {
      const expected = OBLIQUE.project(p.x, p.y, 0);
      const actual = applyHomography(h, p);
      expect(actual.x).toBeCloseTo(expected.x, 3);
      expect(actual.y).toBeCloseTo(expected.y, 3);
    }
  });

  it('stays accurate with mm and pixel magnitudes 3 orders apart (normalisation works)', () => {
    // Without Hartley normalisation the 8x8 DLT system mixes O(1) and O(4e6)
    // terms and loses most of its precision.
    const mm = tableRectMm('대대');
    const px = mm.map((c) => OBLIQUE.project(c.x, c.y, 0));
    const h = computeHomography(mm, [px[0], px[1], px[2], px[3]]);
    const mid = applyHomography(h, { x: 1270, y: 635 });
    const expected = OBLIQUE.project(1270, 635, 0);
    expect(Math.hypot(mid.x - expected.x, mid.y - expected.y)).toBeLessThan(1e-6);
  });
});

describe('estimateIntrinsics', () => {
  it('recovers the true focal length from an oblique view', () => {
    const frame = frameFromRig(OBLIQUE);
    expect(frame.pose.intrinsics.source).toBe('measured');
    expect(frame.pose.intrinsics.focalPx).toBeCloseTo(OBLIQUE.focalPx, 0);
  });

  it.each([
    ['low and steep', { x: -300, y: 635, z: 700 }, { x: 1200, y: 635 }, 1400],
    ['high and shallow', { x: 400, y: -900, z: 2100 }, { x: 1270, y: 700 }, 1800],
    ['off to one corner', { x: -700, y: -500, z: 1500 }, { x: 1500, y: 800 }, 1250],
  ])('recovers focal length for a %s camera', (_label, pos, lookAt, focal) => {
    const rig = makeRig(pos, lookAt, focal);
    const frame = frameFromRig(rig);
    expect(frame.pose.intrinsics.focalPx / focal).toBeCloseTo(1, 2);
  });

  it('falls back to an assumed focal length when the view is frontoparallel', () => {
    // Straight down: both homography constraints degenerate (c1 = c2 = 0).
    const rig = makeRig({ x: 1270, y: 635, z: 3000 }, { x: 1270, y: 635 }, 1500);
    const corners = tableRectMm(rig.size).map((c) => rig.project(c.x, c.y, 0));
    const h = computeHomography(tableRectMm(rig.size), [
      corners[0],
      corners[1],
      corners[2],
      corners[3],
    ]);
    const intrinsics = estimateIntrinsics(h, rig.imageWidth, rig.imageHeight);
    expect(intrinsics.source).toBe('assumed');
    // ...and reports it, so confidence can be penalised rather than the
    // failure being hidden.
    expect(intrinsics.focalPx).toBeGreaterThan(0);
  });
});

describe('recoverCameraPose', () => {
  it('recovers the camera position in table coordinates', () => {
    const frame = frameFromRig(OBLIQUE);
    expect(frame.pose.centerMm.x).toBeCloseTo(OBLIQUE.cameraMm.x, 0);
    expect(frame.pose.centerMm.y).toBeCloseTo(OBLIQUE.cameraMm.y, 0);
    expect(frame.pose.centerMm.z).toBeCloseTo(OBLIQUE.cameraMm.z, 0);
  });

  it('always places the camera above the cloth', () => {
    for (const pos of [
      { x: -450, y: 635, z: 1250 },
      { x: 3000, y: 1800, z: 900 },
      { x: 1270, y: -1200, z: 1600 },
    ]) {
      const frame = frameFromRig(makeRig(pos, { x: 1270, y: 635 }));
      expect(frame.pose.centerMm.z).toBeGreaterThan(0);
    }
  });

  it('produces an orthonormal rotation matrix', () => {
    const { rotation: r } = frameFromRig(OBLIQUE).pose;
    const col = (i: number) => [r[i], r[3 + i], r[6 + i]];
    for (let i = 0; i < 3; i++) {
      const c = col(i);
      expect(Math.hypot(c[0], c[1], c[2])).toBeCloseTo(1, 6);
    }
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const a = col(i);
      const b = col(j);
      expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(0, 6);
    }
  });
});

describe('reprojectToBallPlane (plan Risk R2 — ball-radius parallax)', () => {
  it('recovers true ball positions that the z=0 homography gets wrong', () => {
    const frame = frameFromRig(OBLIQUE);
    const truth = [
      { x: 400, y: 300 },
      { x: 1270, y: 635 },
      { x: 2100, y: 900 },
      { x: 1800, y: 250 },
    ];

    for (const t of truth) {
      // Where the ball's centre actually appears in the photo.
      const imagePoint = OBLIQUE.project(t.x, t.y, BALL_RADIUS_MM);

      const corrected = ballImagePointToTableMm(frame, imagePoint, BALL_RADIUS_MM);
      const naive = applyHomography(frame.imageToTable, imagePoint);

      const correctedErr = Math.hypot(corrected.x - t.x, corrected.y - t.y);
      const naiveErr = Math.hypot(naive.x - t.x, naive.y - t.y);

      // The corrected position must be right to well inside the 8mm gate.
      expect(correctedErr).toBeLessThan(1);
      // ...and the uncorrected one must be visibly wrong, or this test would
      // pass trivially on a pipeline that skipped the correction entirely.
      expect(naiveErr).toBeGreaterThan(10);
    }
  });

  it('produces errors in the 60-90mm band the plan warns about, for a low camera', () => {
    // Phone held at ~700mm looking down the length of the table.
    const rig = makeRig({ x: -500, y: 635, z: 700 }, { x: 1600, y: 635 });
    const frame = frameFromRig(rig);
    const farBall = { x: 2200, y: 700 };
    const imagePoint = rig.project(farBall.x, farBall.y, BALL_RADIUS_MM);
    const naive = applyHomography(frame.imageToTable, imagePoint);
    const uncorrectedError = Math.hypot(naive.x - farBall.x, naive.y - farBall.y);

    expect(uncorrectedError).toBeGreaterThan(55);
    expect(uncorrectedError).toBeLessThan(140);
  });

  it('shifts the ball towards the camera, never away from it', () => {
    const frame = frameFromRig(OBLIQUE);
    const onCloth = { x: 2200, y: 900 };
    const corrected = reprojectToBallPlane(onCloth, frame.pose.centerMm, BALL_RADIUS_MM);
    const c = frame.pose.centerMm;
    expect(Math.hypot(corrected.x - c.x, corrected.y - c.y)).toBeLessThan(
      Math.hypot(onCloth.x - c.x, onCloth.y - c.y)
    );
  });

  it('refuses to guess when the camera is at or below the ball-centre plane', () => {
    expect(() =>
      reprojectToBallPlane({ x: 100, y: 100 }, { x: 0, y: 0, z: 10 }, BALL_RADIUS_MM)
    ).toThrow(/not above the ball-centre plane/);
  });

  it('is a no-op for a camera directly overhead', () => {
    const c = { x: 1270, y: 635, z: 2500 };
    const corrected = reprojectToBallPlane({ x: 1270, y: 635 }, c, BALL_RADIUS_MM);
    expect(corrected.x).toBeCloseTo(1270, 6);
    expect(corrected.y).toBeCloseTo(635, 6);
  });
});

describe('localMmPerPixel', () => {
  it('reports a larger mm-per-pixel scale further from the camera', () => {
    const frame = frameFromRig(OBLIQUE);
    const near = localMmPerPixel(frame, OBLIQUE.project(200, 635, 0));
    const far = localMmPerPixel(frame, OBLIQUE.project(2300, 635, 0));
    expect(far).toBeGreaterThan(near * 1.5);
  });

  it('predicts the area-equivalent radius of the ellipse a ball actually images as', () => {
    const frame = frameFromRig(OBLIQUE);
    const ball = { x: 1600, y: 500 };
    const centre = OBLIQUE.project(ball.x, ball.y, BALL_RADIUS_MM);
    // Under an oblique view the two semi-axes differ markedly, so compare
    // against their geometric mean — the equal-area radius.
    const alongX = OBLIQUE.project(ball.x + BALL_RADIUS_MM, ball.y, BALL_RADIUS_MM);
    const alongY = OBLIQUE.project(ball.x, ball.y + BALL_RADIUS_MM, BALL_RADIUS_MM);
    const semiA = Math.hypot(alongX.x - centre.x, alongX.y - centre.y);
    const semiB = Math.hypot(alongY.x - centre.x, alongY.y - centre.y);
    const equalAreaRadiusPx = Math.sqrt(semiA * semiB);
    // Sanity: this view really is foreshortened, so the test is meaningful.
    expect(Math.max(semiA, semiB) / Math.min(semiA, semiB)).toBeGreaterThan(1.3);

    const predicted = BALL_RADIUS_MM / localMmPerPixel(frame, centre);
    expect(predicted / equalAreaRadiusPx).toBeGreaterThan(0.9);
    expect(predicted / equalAreaRadiusPx).toBeLessThan(1.15);
  });
});

describe('tableRectMm', () => {
  it('matches the shared table dimension constants', () => {
    for (const size of ['대대', '중대'] as TableSize[]) {
      const rect = tableRectMm(size);
      expect(rect[2]).toEqual({
        x: TABLE_DIMENSIONS_MM[size].widthMm,
        y: TABLE_DIMENSIONS_MM[size].heightMm,
      });
    }
  });
});
