/**
 * @vitest-environment node
 *
 * This is a Node-runtime route handler, so it is tested in the Node
 * environment rather than the project-wide jsdom default. jsdom substitutes
 * its own `FormData`/`File`/`Request`, and those do not interoperate with the
 * undici multipart parser that `Request.formData()` actually uses on the
 * server — a multipart body built under jsdom fails to parse even though the
 * identical exchange works in Node and on Vercel.
 */
import { describe, expect, it } from 'vitest';
import { POST } from './route';
import { CUSHION_WIDTH_MM, SYNTHETIC_BALL_RGB, encodePng, renderSyntheticScene } from '@/lib/vision';
import type { RecognizeOutput } from '@/lib/vision';

/**
 * Exercises the HTTP surface end to end: a real rendered photo goes in as a
 * real request body, and a real `RecognitionResult` comes back. This covers the
 * parts unit tests cannot — multipart parsing, base64 handling, settings
 * validation, and the error contract — against the actual exported handler.
 */

const TIMEOUT_MS = 60_000;

function testScene() {
  return renderSyntheticScene({
    tableSize: '대대',
    imageWidth: 1280,
    imageHeight: 960,
    camera: {
      positionMm: { x: -1250, y: 635, z: 1500 },
      lookAtMm: { x: 1270, y: 635 },
      focalPx: 1050,
    },
    balls: [
      { positionMm: { x: 640, y: 420 }, rgb: SYNTHETIC_BALL_RGB.white },
      { positionMm: { x: 1550, y: 880 }, rgb: SYNTHETIC_BALL_RGB.yellow },
      { positionMm: { x: 1980, y: 380 }, rgb: SYNTHETIC_BALL_RGB.red },
      { positionMm: { x: 900, y: 950 }, rgb: SYNTHETIC_BALL_RGB.red },
    ],
    seed: 7,
    // Cloth-coloured cushions, like a real table — see `CUSHION_WIDTH_MM`'s doc.
    cushionWidthMm: CUSHION_WIDTH_MM,
  });
}

function rawJsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/recognize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawBody(scene: ReturnType<typeof testScene>, extra: Record<string, string> = {}) {
  return {
    raw: {
      width: scene.image.width,
      height: scene.image.height,
      dataBase64: Buffer.from(scene.image.data).toString('base64'),
    },
    ...extra,
  };
}

describe('POST /api/recognize', () => {
  it(
    'recognises a table from a raw RGBA JSON body',
    async () => {
      const scene = testScene();
      const response = await POST(rawJsonRequest(rawBody(scene)));
      expect(response.status).toBe(200);

      const body = (await response.json()) as RecognizeOutput;
      expect(body.recognition.balls).toHaveLength(4);
      expect(body.recognition.table.size).toBe('대대');
      expect(body.recognition.confidence).toBeGreaterThan(0);
      expect(body.recognition.needsManualCorrection).toBe(false);

      // Ball positions must land near where the scene was rendered from.
      for (const ball of body.recognition.balls) {
        const nearest = Math.min(
          ...scene.ballPositionsMm.map((t) =>
            Math.hypot(t.x - ball.position.x, t.y - ball.position.y)
          )
        );
        expect(nearest).toBeLessThan(8);
      }
    },
    TIMEOUT_MS
  );

  it(
    'accepts an encoded image via multipart/form-data',
    async () => {
      const scene = testScene();
      const png = await encodePng(scene.image);

      const form = new FormData();
      form.set('image', new File([new Uint8Array(png)], 'table.png', { type: 'image/png' }));
      form.set('tableSize', '대대');
      form.set('cueBallColor', 'yellow');

      const response = await POST(
        new Request('http://localhost/api/recognize', { method: 'POST', body: form })
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as RecognizeOutput;
      expect(body.recognition.balls).toHaveLength(4);
      // The cue-ball setting must drive role assignment.
      const yellow = body.recognition.balls.find((b) => b.color === 'yellow');
      expect(yellow?.role).toBe('cueBall');
    },
    TIMEOUT_MS
  );

  it(
    'accepts a base64 data URL',
    async () => {
      const scene = testScene();
      const png = await encodePng(scene.image);
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;

      const response = await POST(rawJsonRequest({ imageBase64: dataUrl }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as RecognizeOutput;
      expect(body.recognition.balls).toHaveLength(4);
    },
    TIMEOUT_MS
  );

  it(
    'returns pixel-space detections for the confirm/correct screen',
    async () => {
      const scene = testScene();
      const response = await POST(rawJsonRequest(rawBody(scene)));
      const body = (await response.json()) as RecognizeOutput;

      const { pixelDetection } = body;
      expect(pixelDetection.imageWidth).toBe(scene.image.width);
      expect(pixelDetection.imageHeight).toBe(scene.image.height);
      expect(pixelDetection.tableBoundary).toHaveLength(4);
      expect(pixelDetection.balls).toHaveLength(4);

      // Pixel-space balls must be paired 1:1 with the mm-space ones by id.
      expect(pixelDetection.balls.map((b) => b.id).sort()).toEqual(
        body.recognition.balls.map((b) => b.id).sort()
      );
      for (const ball of pixelDetection.balls) {
        expect(ball.x).toBeGreaterThan(0);
        expect(ball.x).toBeLessThan(pixelDetection.imageWidth);
        expect(ball.y).toBeGreaterThan(0);
        expect(ball.y).toBeLessThan(pixelDetection.imageHeight);
        expect(ball.radiusPx).toBeGreaterThan(1);
      }
    },
    TIMEOUT_MS
  );

  it('rejects an unsupported content type with 415', async () => {
    const response = await POST(
      new Request('http://localhost/api/recognize', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'nope',
      })
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: string; stage: string };
    expect(body.stage).toBe('request');
    expect(body.error).toMatch(/Unsupported Content-Type/);
  });

  it('rejects an invalid tableSize with 400', async () => {
    const scene = testScene();
    const response = await POST(rawJsonRequest(rawBody(scene, { tableSize: '소대' })));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/tableSize/);
  });

  it('rejects an invalid cueBallColor with 400', async () => {
    const scene = testScene();
    const response = await POST(rawJsonRequest(rawBody(scene, { cueBallColor: 'green' })));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/cueBallColor/);
  });

  it('rejects a raw buffer whose length disagrees with its dimensions', async () => {
    const response = await POST(
      rawJsonRequest({
        raw: { width: 100, height: 100, dataBase64: Buffer.from([1, 2, 3]).toString('base64') },
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/decodes to 3 bytes, expected 40000/);
  });

  it('rejects a JSON body with neither image field', async () => {
    const response = await POST(rawJsonRequest({ tableSize: '대대' }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/"imageBase64" or "raw"/);
  });

  it(
    'reports a recognition failure as 500 with a diagnostic message',
    async () => {
      // A blank grey image has no table in it at all.
      const width = 320;
      const height = 240;
      const response = await POST(
        rawJsonRequest({
          raw: {
            width,
            height,
            dataBase64: Buffer.from(new Uint8Array(width * height * 4).fill(180)).toString(
              'base64'
            ),
          },
        })
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; stage: string };
      expect(body.stage).toBe('recognition');
      expect(body.error.length).toBeGreaterThan(10);
    },
    TIMEOUT_MS
  );
});
