'use client';

import { useMemo, useRef, useState } from 'react';
// Direct source imports, not the `@/lib/vision` barrel — see the comment in
// lib/orientationFlip.ts for why (barrel also pulls in `sharp` via image.ts,
// which breaks the client bundle from a 'use client' component).
import { ballImagePointToTableMm, projectTablePoint } from '@/lib/vision/camera';
import { BALL_RADIUS_MM } from '@/lib/vision/constants';
import { TABLE_DIMENSIONS_MM, type BallColor, type Point, type RecognitionResult } from '@/lib/types';
import type { PixelDetection } from '@/lib/uiTypes';
import { computeOrientationCandidates } from '@/lib/orientationFlip';
import { railMarkerPoints } from '@/lib/railMarkers';
import styles from './RecognitionConfirm.module.css';

interface Props {
  photoUrl: string;
  recognition: RecognitionResult;
  /** May carry an `approximate: true` tag when synthesized by `lib/mockData.ts` instead of `/api/recognize`. */
  pixelDetection: PixelDetection & { approximate?: boolean };
  onConfirm: (corrected: RecognitionResult) => void;
  onBack: () => void;
}

const BALL_DISPLAY_COLOR: Record<BallColor, string> = {
  white: '#f5f5f5',
  yellow: '#f4c430',
  red1: '#d9291c',
  red2: '#d9291c',
};

const BALL_LABEL: Record<BallColor, string> = {
  white: '흰공',
  yellow: '노랑공',
  red1: '빨간공',
  red2: '빨간공',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Recognition confirmation/correction screen — a *separate* step from the
 * results diagram (per plan "인식 확인 화면 분리"). The photo above stays a
 * static, non-interactive reference (its perspective distortion makes precise
 * dragging on top of it awkward, especially with a finger on a phone screen);
 * actual position correction happens by dragging balls directly in the flat
 * 2D top-down diagram below (문제점 #1, 2026-08 개정) — the same rectified
 * mm-space rectangle the results screen (`ShotDiagram`) renders, so nothing
 * about "up"/"down"/scale changes between correcting and reviewing a shot.
 *
 * An earlier version used a directional-pad (▲▼◀▶) below the photo instead of
 * dragging — replaced because tapping arrows one nudge at a time was reported
 * as too fiddly on mobile.
 */
export default function RecognitionConfirm({ photoUrl, recognition, pixelDetection, onConfirm, onBack }: Props) {
  const [orientationFlipped, setOrientationFlipped] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const editorSvgRef = useRef<SVGSVGElement>(null);
  const photoSvgRef = useRef<SVGSVGElement>(null);

  // The cushion-NOSE line in image pixels — `pixelDetection.tableBoundary` is
  // already `CUSHION_WIDTH_MM`-corrected by the pipeline (see that constant's
  // doc: a real table's cushions are cloth-covered just like the bed, so
  // colour-based segmentation alone can only find the outer rail edge, not
  // where a ball actually rolls to and bounces). That correction is an
  // estimate, not a per-table measurement, so it's kept in state here and
  // exposed as 4 draggable corners on the photo for the user to fine-tune
  // directly — pixelDetection.outerTableBoundary (the raw, uncorrected outer
  // edge) is shown alongside, non-interactive, purely as a visual reference
  // for "how far in from that outer line the nose should be".
  const [corners, setCorners] = useState<[Point, Point, Point, Point]>(pixelDetection.tableBoundary);
  const [draggingCorner, setDraggingCorner] = useState<number | null>(null);

  // Both candidate table orientations for the current (possibly user-
  // corrected) nose-line corners — recomputed purely client-side (no OpenCV,
  // no network round-trip). `auto` is whichever one the backend actually
  // picked; `alternate` is the 90°-relabeled other one. See
  // lib/orientationFlip.ts for why this exists: the automatic picker is
  // provably wrong on some real "down the length of the table" photos.
  const { auto: autoFrame, alternate: alternateFrame } = useMemo(
    () =>
      computeOrientationCandidates(
        corners,
        recognition.table.size,
        pixelDetection.imageWidth,
        pixelDetection.imageHeight,
      ),
    [corners, recognition.table.size, pixelDetection.imageWidth, pixelDetection.imageHeight],
  );
  const activeFrame = orientationFlipped ? alternateFrame : autoFrame;

  // Where "긴 변"/"짧은 변" actually land on the photo for the CURRENTLY
  // active frame — projecting the real table-mm midpoints back into pixel
  // space, so the labels move live when the user taps "가로/세로 바꾸기"
  // instead of just trusting a button click happened (문제점 #2, follow-up:
  // show how the judgement is made, not just let it be toggled blindly).
  const orientationLabels = useMemo(() => {
    const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[recognition.table.size];
    const project = (mm: Point) => projectTablePoint(activeFrame, mm, 0);
    return [
      { text: `긴 변 (${widthMm}mm)`, at: project({ x: widthMm / 2, y: 0 }) },
      { text: `긴 변 (${widthMm}mm)`, at: project({ x: widthMm / 2, y: heightMm }) },
      { text: `짧은 변 (${heightMm}mm)`, at: project({ x: 0, y: heightMm / 2 }) },
      { text: `짧은 변 (${heightMm}mm)`, at: project({ x: widthMm, y: heightMm / 2 }) },
    ];
  }, [activeFrame, recognition.table.size]);

  // Ball positions in real-world mm space (the same space `Ball.position`/
  // `TableGeometry` use), derived from the raw pixel detections through
  // whichever table frame is currently active — using the exact z=ball-radius
  // corrected mapping the vision pipeline itself uses
  // (lib/vision/camera.ts#ballImagePointToTableMm), not an approximation.
  // Flipping orientation changes this mapping fundamentally (not just a
  // display label), so it's recomputed below whenever `activeFrame` changes.
  const initialPositions = useMemo(
    () =>
      Object.fromEntries(
        pixelDetection.balls.map((b) => [
          b.id,
          ballImagePointToTableMm(activeFrame, { x: b.x, y: b.y }, BALL_RADIUS_MM),
        ]),
      ) as Record<string, Point>,
    [pixelDetection.balls, activeFrame],
  );

  const [positions, setPositions] = useState<Record<string, Point>>(initialPositions);
  // Reset any manual drag correction whenever orientation flips — adjusting
  // state during render (rather than in a useEffect) is the pattern React
  // recommends for "reset state when a prop changes"; see ShotDiagram's
  // `prevShots`/`selected` for the same pattern in this codebase.
  const [prevFrame, setPrevFrame] = useState(activeFrame);
  if (activeFrame !== prevFrame) {
    setPrevFrame(activeFrame);
    setPositions(initialPositions);
  }

  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[recognition.table.size];

  // 2D top-down drag surface geometry — deliberately mirrors ShotDiagram's
  // mm-space rendering (same boundary polygon, same Y-flip) so the table looks
  // and is oriented identically here and on the results screen.
  const boundary = recognition.table.boundary;
  const boundaryXs = boundary.map((p) => p.x);
  const boundaryYs = boundary.map((p) => p.y);
  const editorMargin = BALL_RADIUS_MM * 3;
  const editorMinX = Math.min(...boundaryXs) - editorMargin;
  const editorMaxX = Math.max(...boundaryXs) + editorMargin;
  const editorMinY = Math.min(...boundaryYs) - editorMargin;
  const editorMaxY = Math.max(...boundaryYs) + editorMargin;
  const flipK = editorMinY + editorMaxY;
  const boundaryPoints = boundary.map((p) => `${p.x},${p.y}`).join(' ');
  const railDots = railMarkerPoints(boundary);
  // True-to-scale ball size (사용자 피드백: 실제 비율보다 크게 그려서 공 위치가
  // 헷갈림) — the viewBox is already in real mm, so the ball's own real radius
  // is the correct SVG radius. The drag *hit target* stays deliberately
  // larger than the visible ball (a finger is bigger than a true-scale ball
  // rendered on a phone screen), but that circle is invisible so it doesn't
  // mislead position judgement the way an oversized visible ball would.
  const ballDisplayRadius = BALL_RADIUS_MM;
  const dragHandleRadius = BALL_RADIUS_MM * 1.8;
  // Rail dots are a purely decorative visual size, independent of the
  // (now true-to-scale, much smaller) ball radius — tying it to `ballDisplayRadius`
  // would shrink these to near-invisible.
  const railDotRadius = (editorMaxX - editorMinX) * 0.006;

  /** Convert a pointer event's screen position into the same mm-space
   * `positions` are stored in — via the SVG's own screen CTM, which already
   * accounts for viewBox scaling and responsive sizing, then undoing the
   * inner `<g>`'s Y-flip (a self-inverse reflection, so the same formula
   * applies both ways: `local = flipK - root`). */
  function clientToMm(clientX: number, clientY: number): Point | null {
    const svg = editorSvgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const root = pt.matrixTransform(ctm.inverse());
    return { x: root.x, y: flipK - root.y };
  }

  function moveBallTo(id: string, clientX: number, clientY: number) {
    const mm = clientToMm(clientX, clientY);
    if (!mm) return;
    setPositions((prev) => ({
      ...prev,
      [id]: {
        x: clamp(mm.x, BALL_RADIUS_MM, widthMm - BALL_RADIUS_MM),
        y: clamp(mm.y, BALL_RADIUS_MM, heightMm - BALL_RADIUS_MM),
      },
    }));
  }

  function handlePointerDown(id: string, e: React.PointerEvent<SVGCircleElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingId(id);
    moveBallTo(id, e.clientX, e.clientY);
  }

  function handlePointerMove(id: string, e: React.PointerEvent<SVGCircleElement>) {
    // `setPointerCapture` above already routes every subsequent move for this
    // pointerId back to this exact circle regardless of where the finger
    // physically is, so no extra "is this still the active drag" check is
    // needed — and skipping it means two balls can be dragged at once (two
    // simultaneous touches) without one drag clobbering the other.
    moveBallTo(id, e.clientX, e.clientY);
  }

  function handlePointerUp(e: React.PointerEvent<SVGCircleElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDraggingId(null);
  }

  /** Screen position → the photo overlay SVG's own pixel space (its viewBox
   * is `0 0 imageWidth imageHeight` with no inner transform, so this is
   * simpler than `clientToMm` above — no Y-flip to undo). */
  function clientToPixel(clientX: number, clientY: number): Point | null {
    const svg = photoSvgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function moveCornerTo(index: number, clientX: number, clientY: number) {
    const p = clientToPixel(clientX, clientY);
    if (!p) return;
    setCorners((prev) => {
      const next = [...prev] as [Point, Point, Point, Point];
      next[index] = {
        x: clamp(p.x, 0, pixelDetection.imageWidth),
        y: clamp(p.y, 0, pixelDetection.imageHeight),
      };
      return next;
    });
  }

  function handleCornerPointerDown(index: number, e: React.PointerEvent<SVGCircleElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingCorner(index);
    moveCornerTo(index, e.clientX, e.clientY);
  }

  function handleCornerPointerMove(index: number, e: React.PointerEvent<SVGCircleElement>) {
    moveCornerTo(index, e.clientX, e.clientY);
  }

  function handleCornerPointerUp(e: React.PointerEvent<SVGCircleElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDraggingCorner(null);
  }

  function handleConfirm() {
    // `positions` is already expressed in the same mm-space `Ball.position`
    // uses, under whichever table frame is currently active — the drag
    // surface *is* that space, so no further conversion happens here.
    const correctedBalls = recognition.balls.map((ball) => ({
      ...ball,
      position: positions[ball.id] ?? ball.position,
    }));

    onConfirm({ ...recognition, balls: correctedBalls, needsManualCorrection: false });
  }

  const noseBoundaryPoints = corners.map((p) => `${p.x},${p.y}`).join(' ');
  const outerBoundaryPoints = pixelDetection.outerTableBoundary.map((p) => `${p.x},${p.y}`).join(' ');
  const cornerHandleRadius = Math.min(pixelDetection.imageWidth, pixelDetection.imageHeight) * 0.014;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>인식 결과 확인</h2>
      <p className={styles.hint}>
        사진 위 <strong>초록 실선</strong>은 공이 실제로 튕기는 쿠션 선이고, <strong>주황 점선</strong>은 자동 인식된
        천 바깥쪽 경계입니다 (당구대 쿠션은 바닥 천과 색이 같아 자동으로는 둘을 구분하기 어려워, 표준 쿠션 폭만큼
        안쪽으로 추정해 표시했습니다). 초록 선이 실제 쿠션 선과 다르면 모서리 4개를 직접 끌어 맞춰주세요. 공 위치는
        아래 2D 테이블 그림에서 손가락으로 끌어 옮길 수 있습니다.
      </p>

      {recognition.needsManualCorrection && (
        <p className={styles.warningBanner} role="alert">
          인식 신뢰도가 낮습니다. 특히 큐볼(내 공) 색상 오인식은 추천 전체를 틀리게 만들 수 있으니 꼭 확인해주세요.
        </p>
      )}
      {pixelDetection.approximate && (
        <p className={styles.infoBanner}>사진 위 오버레이 위치는 근사치입니다 (정밀 인식 좌표 연동 전 표시).</p>
      )}

      <div className={styles.imageWrap} style={{ aspectRatio: `${pixelDetection.imageWidth} / ${pixelDetection.imageHeight}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimizable remote asset */}
        <img src={photoUrl} alt="업로드한 당구대 사진" className={styles.photo} />
        <svg
          ref={photoSvgRef}
          className={styles.overlay}
          viewBox={`0 0 ${pixelDetection.imageWidth} ${pixelDetection.imageHeight}`}
          preserveAspectRatio="none"
        >
          {/* Reference only — the raw outer cloth/rail edge, before the
           * cushion-width correction. Never interactive: correcting this one
           * directly would just be redoing what CUSHION_WIDTH_MM already
           * estimates, and it's not itself the thing that matters physically. */}
          <polygon points={outerBoundaryPoints} className={styles.outerTableBoundary} />
          <polygon points={noseBoundaryPoints} className={styles.tableBoundary} />
          {orientationLabels.map((label, i) => (
            <text
              key={i}
              x={label.at.x}
              y={label.at.y}
              textAnchor="middle"
              className={styles.orientationLabel}
            >
              {label.text}
            </text>
          ))}
          {pixelDetection.balls.map((ball) => (
            <circle
              key={ball.id}
              cx={ball.x}
              cy={ball.y}
              r={ball.radiusPx}
              fill={BALL_DISPLAY_COLOR[ball.color]}
              stroke="#222"
              strokeWidth={ball.radiusPx * 0.12}
              className={styles.ballMarker}
            >
              <title>{BALL_LABEL[ball.color]}</title>
            </circle>
          ))}
          {corners.map((c, i) => (
            <circle
              key={`corner-${i}`}
              cx={c.x}
              cy={c.y}
              r={cornerHandleRadius}
              className={`${styles.cornerHandle} ${draggingCorner === i ? styles.cornerHandleActive : ''}`}
              onPointerDown={(e) => handleCornerPointerDown(i, e)}
              onPointerMove={(e) => handleCornerPointerMove(i, e)}
              onPointerUp={handleCornerPointerUp}
              onPointerCancel={handleCornerPointerUp}
            >
              <title>쿠션 선 모서리 {i + 1} — 끌어서 조정</title>
            </circle>
          ))}
        </svg>
      </div>

      <div className={styles.orientationRow}>
        <span className={styles.orientationHint}>
          사진 위 노란 글씨가 실제 당구대와 반대로 표시됐다면 (긴 변인데 &quot;짧은 변&quot;이라고 나오는 등):
        </span>
        <button
          type="button"
          className={`${styles.orientationButton} ${orientationFlipped ? styles.orientationButtonActive : ''}`}
          aria-pressed={orientationFlipped}
          onClick={() => setOrientationFlipped((v) => !v)}
        >
          가로/세로 바꾸기
        </button>
      </div>

      <div className={styles.correctionPanel}>
        <div className={styles.correctionHeader}>
          <span className={styles.correctionTitle}>공을 끌어서 실제 위치로 옮기기</span>
        </div>

        <div className={styles.editorWrap}>
          <svg
            ref={editorSvgRef}
            viewBox={`${editorMinX} ${editorMinY} ${editorMaxX - editorMinX} ${editorMaxY - editorMinY}`}
            className={styles.editorSvg}
          >
            <g transform={`translate(0, ${flipK}) scale(1, -1)`}>
              <polygon points={boundaryPoints} className={styles.editorTable} />

              {railDots.map((p, i) => (
                <circle key={`rail-${i}`} cx={p.x} cy={p.y} r={railDotRadius} className={styles.editorRailDot} />
              ))}

              {pixelDetection.balls.map((ball) => {
                const pos = positions[ball.id];
                if (!pos) return null;
                return (
                  <g key={ball.id}>
                    {/* Larger invisible hit target — the true-to-scale ball
                     * circle below is too small to grab reliably with a
                     * finger, especially near the table's long-side scale. */}
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={dragHandleRadius}
                      className={styles.dragHandle}
                      onPointerDown={(e) => handlePointerDown(ball.id, e)}
                      onPointerMove={(e) => handlePointerMove(ball.id, e)}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerUp}
                    >
                      <title>{BALL_LABEL[ball.color]}</title>
                    </circle>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={ballDisplayRadius}
                      fill={BALL_DISPLAY_COLOR[ball.color]}
                      stroke={draggingId === ball.id ? '#0a6cff' : '#222'}
                      strokeWidth={ballDisplayRadius * (draggingId === ball.id ? 0.22 : 0.12)}
                      className={styles.draggableBall}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        <ul className={styles.legend}>
          {pixelDetection.balls.map((ball) => (
            <li key={ball.id} className={styles.legendItem}>
              <span className={styles.ballSwatch} style={{ background: BALL_DISPLAY_COLOR[ball.color] }} aria-hidden="true" />
              {BALL_LABEL[ball.color]}
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} onClick={onBack}>
          다시 촬영
        </button>
        <button type="button" className={styles.primaryButton} onClick={handleConfirm}>
          확정하고 경로 계산
        </button>
      </div>
    </div>
  );
}
