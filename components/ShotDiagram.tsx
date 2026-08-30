'use client';

import { useRef, useState } from 'react';
import { FORCE_LEVEL_LABEL, type Ball, type Shot, type TableGeometry } from '@/lib/types';
import type { PathCalcShotResult } from '@/lib/uiTypes';
import { railMarkerPoints } from '@/lib/railMarkers';
import { BALL_DISPLAY_COLOR } from '@/lib/ballVisuals';
import { BALL_RADIUS_MM, classifySpin, type SpinLabel } from '@/lib/pathcalc';
import CueBallAim from './CueBallAim';
import styles from './ShotDiagram.module.css';

interface Props {
  table: TableGeometry;
  balls: Ball[];
  /** Up to 3 candidates, already sorted by the API — rendered in this order, not re-sorted here. */
  shots: PathCalcShotResult[];
  /** True when `shots` is a single closest-miss reference shot, not a normal recommendation. */
  fallback: boolean;
}

// "뱅킹"은 쓰지 않는다 — "1쿠션"/"2쿠션 이상"(적구를 먼저 맞고 쿠션을 나중에
// 맞히는 경유 샷)과 "뱅크샷"(쿠션을 먼저 맞고 적구를 나중에 맞히는 빈쿠션치기/
// 가락)은 서로 다른 기술이므로 별도 라벨을 쓴다 — lib/types.ts의
// `ShotTechnique` 문서와 lib/pathcalc/candidates.ts#classifyTechnique 참고.
// "고급 기술샷(스핀)"이라는 별도 기술 라벨도 없다 — 회전 여부와 무관하게
// 쿠션 횟수로만 분류한다 (끌어치기/밀어치기/회전 샷도 쿠션이 0번이면 그냥
// "직접샷"). 회전 정보는 CueBallAim의 당점 표시와 설문조사 우선순위 반영으로
// 대체된다.
const TECHNIQUE_LABEL: Record<Shot['technique'], string> = {
  direct: '직접샷',
  bank1: '1쿠션',
  bank2plus: '2쿠션 이상',
  bankShot: '뱅크샷',
};

/** `classifySpin`'s result, in Korean, for display next to the technique
 * label — e.g. "직접샷(밀어치기)"/"1쿠션(회전)". `'plain'` still shows a
 * label ("일반") rather than being omitted, so every shot's spin is stated
 * explicitly and not just implied by its absence. */
const SPIN_LABEL: Record<SpinLabel, string> = {
  draw: '끌어치기',
  follow: '밀어치기',
  spin: '회전',
  plain: '일반',
};

function techniqueWithSpinLabel(shot: Shot): string {
  return `${TECHNIQUE_LABEL[shot.technique]}(${SPIN_LABEL[classifySpin(shot.tipOffset)]})`;
}

/** Below this confidence, a shot is visually de-emphasized per plan "low-confidence 후보 시각적 구분". */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export default function ShotDiagram({ table, balls, shots, fallback }: Props) {
  const [selected, setSelected] = useState(0);
  // Reset the selected tab whenever a new set of candidates comes in. Adjusting
  // state during render (rather than in a useEffect) is the pattern React
  // recommends for "reset state when a prop changes" — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [prevShots, setPrevShots] = useState(shots);
  if (shots !== prevShots) {
    setPrevShots(shots);
    setSelected(0);
  }
  const touchStartX = useRef<number | null>(null);

  if (shots.length === 0) {
    return <p className={styles.empty}>표시할 샷 후보가 없습니다.</p>;
  }

  const entry = shots[Math.min(selected, shots.length - 1)];
  const shot = entry.shot;
  const isLowConfidence = shot.confidence < LOW_CONFIDENCE_THRESHOLD;

  const allX = [...table.boundary.map((p) => p.x), ...balls.map((b) => b.position.x)];
  const allY = [...table.boundary.map((p) => p.y), ...balls.map((b) => b.position.y)];
  const margin = 100;
  const minX = Math.min(...allX) - margin;
  const maxX = Math.max(...allX) + margin;
  const minY = Math.min(...allY) - margin;
  const maxY = Math.max(...allY) + margin;

  const tablePoints = table.boundary.map((p) => `${p.x},${p.y}`).join(' ');
  // Real cue-ball path polyline from lib/pathcalc's simulator (includes cushion
  // bounce points for bank shots) — not a client-side approximation.
  const pathPoints = entry.path;
  // True-to-scale ball size (사용자 피드백: 실제 비율보다 크게 그려서 공 위치가
  // 헷갈림) — the viewBox is already in real mm, so the ball's own real radius
  // is the correct SVG radius, no arbitrary visual-scale fraction needed.
  const ballRadius = BALL_RADIUS_MM;
  // Rail sight/diamond markers (문제점 #3) — real carom tables have these
  // along every rail; the reconstructed diagram was missing them entirely.
  // They sit on the wood rail, just outside the cushion nose line the table
  // polygon traces — nudge each point outward from centre so they read as
  // "on the rail" rather than sitting on the cloth boundary itself.
  const centroid = {
    x: table.boundary.reduce((s, p) => s + p.x, 0) / 4,
    y: table.boundary.reduce((s, p) => s + p.y, 0) / 4,
  };
  const railOutset = Math.min(maxX - minX, maxY - minY) * 0.02;
  const railDots = railMarkerPoints(table.boundary).map((p) => {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * railOutset, y: p.y + (dy / len) * railOutset };
  });
  // Independent of `ballRadius` now that it's true-to-scale — these are a
  // purely decorative visual size, not a real-world-accurate diamond size, so
  // they'd shrink to near-invisible if scaled off the (now much smaller) real
  // ball radius instead.
  const railDotRadius = (maxX - minX) * 0.0044;

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    const SWIPE_THRESHOLD = 40;
    if (dx > SWIPE_THRESHOLD) setSelected((i) => Math.max(0, i - 1));
    else if (dx < -SWIPE_THRESHOLD) setSelected((i) => Math.min(shots.length - 1, i + 1));
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>추천 샷</h2>

      {fallback && (
        <p className={styles.fallbackBanner} role="alert">
          정확히 맞는 샷을 찾지 못했습니다 — 가장 근접한 참고용 샷입니다.
        </p>
      )}

      {!fallback && shots.length > 1 && (
        <div className={styles.tabs} role="tablist">
          {shots.map((s, i) => (
            <button
              key={s.shot.id}
              type="button"
              role="tab"
              aria-selected={i === selected}
              className={`${styles.tab} ${i === selected ? styles.tabActive : ''} ${
                s.shot.confidence < LOW_CONFIDENCE_THRESHOLD ? styles.tabLowConfidence : ''
              }`}
              onClick={() => setSelected(i)}
            >
              {techniqueWithSpinLabel(s.shot)}
            </button>
          ))}
        </div>
      )}

      <div
        className={`${styles.diagramWrap} ${isLowConfidence ? styles.lowConfidence : ''}`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {isLowConfidence && <span className={styles.lowConfidenceBadge}>낮은 신뢰도</span>}
        <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className={styles.svg}>
          {/* `TableGeometry`/`Ball.position` are Y-UP (table mm space), but SVG
           * is Y-DOWN — plotting mm coordinates straight into SVG coordinates
           * renders the whole layout mirrored top-to-bottom. This flips Y back
           * within the same viewBox bounds so "up" in the diagram matches "up"
           * on the real table, not its vertical mirror image. */}
          <g transform={`translate(0, ${minY + maxY}) scale(1, -1)`}>
            <polygon points={tablePoints} className={styles.table} />

            {railDots.map((p, i) => (
              <circle key={`rail-${i}`} cx={p.x} cy={p.y} r={railDotRadius} className={styles.railDot} />
            ))}

            {pathPoints.length >= 2 && (
              <polyline
                points={pathPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                className={styles.pathLine}
                markerEnd="url(#arrowhead)"
              />
            )}

            {balls.map((ball) => (
              <circle
                key={ball.id}
                cx={ball.position.x}
                cy={ball.position.y}
                r={ballRadius}
                fill={BALL_DISPLAY_COLOR[ball.color]}
                stroke="#222"
                strokeWidth={ballRadius * 0.15}
              />
            ))}
          </g>

          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="#0a6cff" />
            </marker>
          </defs>
        </svg>
      </div>

      <CueBallAim tipOffset={shot.tipOffset} thickness={shot.aimTarget.thickness} />

      <dl className={styles.details}>
        <div className={styles.detailRow}>
          <dt>기술</dt>
          <dd>{techniqueWithSpinLabel(shot)}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt>각도 (참고용)</dt>
          <dd>{shot.angleDeg.toFixed(0)}°</dd>
        </div>
        <div className={`${styles.detailRow} ${styles.detailRowWide}`}>
          <dt>힘</dt>
          <dd className={styles.forceDetail}>
            <span className={styles.forceScale} aria-hidden="true">
              {[1, 2, 3, 4, 5].map((level) => (
                <span key={level} className={`${styles.forceDot} ${level <= shot.forceLevel ? styles.forceDotFilled : ''}`} />
              ))}
            </span>
            <span className={styles.forceLabel}>
              {shot.forceLevel} — {FORCE_LEVEL_LABEL[shot.forceLevel]}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
