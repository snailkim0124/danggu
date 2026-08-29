'use client';

import { useMemo, useState } from 'react';
// Direct source imports, not the `@/lib/vision` barrel — see the comment in
// lib/orientationFlip.ts for why (barrel also pulls in `sharp` via image.ts,
// which breaks the client bundle from a 'use client' component).
import { ballImagePointToTableMm, projectTablePoint } from '@/lib/vision/camera';
import { BALL_RADIUS_MM } from '@/lib/vision/constants';
import { TABLE_DIMENSIONS_MM, type BallColor, type Point, type RecognitionResult } from '@/lib/types';
import type { PixelDetection } from '@/lib/uiTypes';
import { computeOrientationCandidates } from '@/lib/orientationFlip';
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

/** Nudge step per tap, as a fraction of the image's own dimensions — so the
 * step feels the same regardless of photo resolution. Two sizes: a coarse
 * default step and a fine one (⇧) for the last bit of precision. */
const COARSE_STEP_FRACTION = 0.02;
const FINE_STEP_FRACTION = 0.005;

type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Recognition confirmation/correction screen — a *separate* step from the
 * results diagram (per plan "인식 확인 화면 분리"). Shows the uploaded photo
 * with the detected table boundary and ball positions overlaid as a visual
 * reference; correction happens via a directional-pad control **below the
 * photo** for each ball (문제점 #3), rather than by dragging markers on top of
 * the photo — a finger dragging directly on a small photo occludes the very
 * point it's trying to place precisely, especially on a phone screen.
 */
export default function RecognitionConfirm({ photoUrl, recognition, pixelDetection, onConfirm, onBack }: Props) {
  const [positions, setPositions] = useState<Record<string, Point>>(() =>
    Object.fromEntries(pixelDetection.balls.map((b) => [b.id, { x: b.x, y: b.y }]))
  );
  const [fineMode, setFineMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orientationFlipped, setOrientationFlipped] = useState(false);

  // Both candidate table orientations for this photo's detected boundary —
  // recomputed purely client-side (no OpenCV, no network round-trip) from
  // the pixel quad `/api/recognize` already returned. `auto` is whichever one
  // the backend actually picked; `alternate` is the 90°-relabeled other one.
  // See lib/orientationFlip.ts for why this exists: the automatic picker is
  // provably wrong on some real "down the length of the table" photos.
  const { auto: autoFrame, alternate: alternateFrame } = useMemo(
    () =>
      computeOrientationCandidates(
        pixelDetection.tableBoundary,
        recognition.table.size,
        pixelDetection.imageWidth,
        pixelDetection.imageHeight,
      ),
    [pixelDetection, recognition.table.size],
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

  function nudge(id: string, direction: Direction) {
    const fraction = fineMode ? FINE_STEP_FRACTION : COARSE_STEP_FRACTION;
    const stepX = pixelDetection.imageWidth * fraction;
    const stepY = pixelDetection.imageHeight * fraction;
    setPositions((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const delta =
        direction === 'up'
          ? { x: 0, y: -stepY }
          : direction === 'down'
            ? { x: 0, y: stepY }
            : direction === 'left'
              ? { x: -stepX, y: 0 }
              : { x: stepX, y: 0 };
      return {
        ...prev,
        [id]: {
          x: clamp(current.x + delta.x, 0, pixelDetection.imageWidth),
          y: clamp(current.y + delta.y, 0, pixelDetection.imageHeight),
        },
      };
    });
  }

  function handleConfirm() {
    // Uses the same z=ball-radius-corrected mapping the vision pipeline uses
    // (lib/vision/camera.ts#ballImagePointToTableMm) under whichever table
    // frame is currently active (auto-picked, or flipped by the user) —
    // not an approximation, so a corrected/flipped position is exactly as
    // accurate as an original, untouched detection.
    const correctedBalls = recognition.balls.map((ball) => {
      const pixelPos = positions[ball.id];
      if (!pixelPos) return ball;
      return { ...ball, position: ballImagePointToTableMm(activeFrame, pixelPos, BALL_RADIUS_MM) };
    });

    onConfirm({ ...recognition, balls: correctedBalls, needsManualCorrection: false });
  }

  const boundaryPoints = pixelDetection.tableBoundary.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>인식 결과 확인</h2>
      <p className={styles.hint}>
        공 위치가 실제와 다르면 아래 방향 버튼으로 조정해주세요. 사진은 참고용이며 직접 드래그할 수 없습니다.
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
          className={styles.overlay}
          viewBox={`0 0 ${pixelDetection.imageWidth} ${pixelDetection.imageHeight}`}
          preserveAspectRatio="none"
        >
          <polygon points={boundaryPoints} className={styles.tableBoundary} />
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
          {pixelDetection.balls.map((ball) => {
            const pos = positions[ball.id] ?? { x: ball.x, y: ball.y };
            return (
              <circle
                key={ball.id}
                cx={pos.x}
                cy={pos.y}
                r={ball.radiusPx}
                fill={BALL_DISPLAY_COLOR[ball.color]}
                stroke={selectedId === ball.id ? '#0a6cff' : '#222'}
                strokeWidth={ball.radiusPx * (selectedId === ball.id ? 0.22 : 0.12)}
                className={styles.ballMarker}
              >
                <title>{BALL_LABEL[ball.color]}</title>
              </circle>
            );
          })}
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
          <span className={styles.correctionTitle}>아래에서 위치 조정</span>
          <label className={styles.fineToggle}>
            <input type="checkbox" checked={fineMode} onChange={(e) => setFineMode(e.target.checked)} />
            정밀 조정
          </label>
        </div>

        {pixelDetection.balls.map((ball) => (
          <div
            key={ball.id}
            className={`${styles.ballRow} ${selectedId === ball.id ? styles.ballRowSelected : ''}`}
          >
            <span
              className={styles.ballSwatch}
              style={{ background: BALL_DISPLAY_COLOR[ball.color] }}
              aria-hidden="true"
            />
            <span className={styles.ballRowLabel}>{BALL_LABEL[ball.color]}</span>
            <div className={styles.dpad}>
              <button
                type="button"
                className={`${styles.dpadButton} ${styles.dpadUp}`}
                aria-label={`${BALL_LABEL[ball.color]} 위로`}
                onClick={() => {
                  setSelectedId(ball.id);
                  nudge(ball.id, 'up');
                }}
              >
                ▲
              </button>
              <button
                type="button"
                className={`${styles.dpadButton} ${styles.dpadLeft}`}
                aria-label={`${BALL_LABEL[ball.color]} 왼쪽으로`}
                onClick={() => {
                  setSelectedId(ball.id);
                  nudge(ball.id, 'left');
                }}
              >
                ◀
              </button>
              <button
                type="button"
                className={`${styles.dpadButton} ${styles.dpadRight}`}
                aria-label={`${BALL_LABEL[ball.color]} 오른쪽으로`}
                onClick={() => {
                  setSelectedId(ball.id);
                  nudge(ball.id, 'right');
                }}
              >
                ▶
              </button>
              <button
                type="button"
                className={`${styles.dpadButton} ${styles.dpadDown}`}
                aria-label={`${BALL_LABEL[ball.color]} 아래로`}
                onClick={() => {
                  setSelectedId(ball.id);
                  nudge(ball.id, 'down');
                }}
              >
                ▼
              </button>
            </div>
          </div>
        ))}
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
