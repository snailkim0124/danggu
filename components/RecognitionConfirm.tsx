'use client';

import { useMemo, useRef, useState } from 'react';
// Direct source imports, not the `@/lib/vision` barrel — see the comment in
// lib/orientationFlip.ts for why (barrel also pulls in `sharp` via image.ts,
// which breaks the client bundle from a 'use client' component).
import { ballImagePointToTableMm, projectTablePoint } from '@/lib/vision/camera';
import { BALL_RADIUS_MM } from '@/lib/vision/constants';
import { TABLE_DIMENSIONS_MM, type Point, type RecognitionResult } from '@/lib/types';
import type { PixelDetection } from '@/lib/uiTypes';
import { computeOrientationCandidates } from '@/lib/orientationFlip';
import { BALL_DISPLAY_COLOR, BALL_LABEL } from '@/lib/ballVisuals';
import BallPositionEditor from './BallPositionEditor';
import styles from './RecognitionConfirm.module.css';

interface Props {
  photoUrl: string;
  recognition: RecognitionResult;
  /** May carry an `approximate: true` tag when synthesized by `lib/mockData.ts` instead of `/api/recognize`. */
  pixelDetection: PixelDetection & { approximate?: boolean };
  onConfirm: (corrected: RecognitionResult) => void;
  onBack: () => void;
}

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
  const boundary = recognition.table.boundary;

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

  // `pixelDetection.approximate` means there was no real per-photo detection
  // at all (lib/mockData.ts's fallback) — the boundary/ball pixel positions
  // are a fabricated illustrative layout, not anything derived from this
  // photo. Drawing them (and letting the user "correct" corners that don't
  // correspond to anything real) would be actively misleading, and position
  // correction already works fully from the 2D editor below regardless — so
  // the photo overlay is skipped entirely in this mode, not just de-emphasized.
  const hasRealOverlay = !pixelDetection.approximate;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>인식 결과 확인</h2>
      {hasRealOverlay ? (
        <p className={styles.hint}>
          사진 위 <strong>초록 실선</strong>은 공이 실제로 튕기는 쿠션 선이고, <strong>주황 점선</strong>은 자동
          인식된 천 바깥쪽 경계입니다 (당구대 쿠션은 바닥 천과 색이 같아 자동으로는 둘을 구분하기 어려워, 표준
          쿠션 폭만큼 안쪽으로 추정해 표시했습니다). 초록 선이 실제 쿠션 선과 다르면 모서리 4개를 직접 끌어
          맞춰주세요. 공 위치는 아래 2D 테이블 그림에서 손가락으로 끌어 옮길 수 있습니다.
        </p>
      ) : (
        <p className={styles.hint}>
          사진에서 정확한 위치를 인식하지 못해 사진 위에는 아무 것도 표시하지 않습니다. 아래 사진을 참고해서, 2D
          테이블 그림에서 공 위치를 손가락으로 직접 맞춰주세요.
        </p>
      )}

      {recognition.needsManualCorrection && (
        <p className={styles.warningBanner} role="alert">
          인식 신뢰도가 낮습니다. 특히 큐볼(내 공) 색상 오인식은 추천 전체를 틀리게 만들 수 있으니 꼭 확인해주세요.
        </p>
      )}
      {pixelDetection.approximate && (
        <p className={styles.infoBanner}>사진 인식에 실패해 샘플 배치로 대체했습니다 — 아래에서 실제 위치로 맞춰주세요.</p>
      )}

      <div className={styles.imageWrap} style={{ aspectRatio: `${pixelDetection.imageWidth} / ${pixelDetection.imageHeight}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimizable remote asset */}
        <img src={photoUrl} alt="업로드한 당구대 사진" className={styles.photo} />
        {hasRealOverlay && (
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
        )}
      </div>

      {hasRealOverlay && (
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
      )}

      <div className={styles.correctionPanel}>
        <div className={styles.correctionHeader}>
          <span className={styles.correctionTitle}>공을 끌어서 실제 위치로 옮기기</span>
        </div>

        <BallPositionEditor
          boundary={boundary}
          widthMm={widthMm}
          heightMm={heightMm}
          balls={pixelDetection.balls.map((b) => ({ id: b.id, color: b.color }))}
          positions={positions}
          onPositionsChange={setPositions}
        />
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
