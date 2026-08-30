'use client';

import { useRef, useState } from 'react';
import { BALL_RADIUS_MM } from '@/lib/vision/constants';
import { BALL_DISPLAY_COLOR, BALL_LABEL } from '@/lib/ballVisuals';
import { railMarkerPoints } from '@/lib/railMarkers';
import type { BallColor, Point } from '@/lib/types';
import styles from './BallPositionEditor.module.css';

export interface EditableBall {
  id: string;
  color: BallColor;
}

interface Props {
  /** Cushion-nose-line rectangle in mm space (`TableGeometry.boundary`). */
  boundary: [Point, Point, Point, Point];
  widthMm: number;
  heightMm: number;
  balls: EditableBall[];
  /** mm-space position per `EditableBall.id`. A ball with no entry is not rendered. */
  positions: Record<string, Point>;
  onPositionsChange: (next: Record<string, Point>) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 2D top-down drag surface for placing/correcting ball positions in real mm
 * space — extracted out of `RecognitionConfirm.tsx` (문제점 #1: dragging the
 * flat diagram instead of the perspective-distorted photo) so the identical
 * UI can be reused by any screen that needs "let the user put 4 balls
 * somewhere on the table" without depending on a photo ever having existed
 * (see `app/manual-setup/page.tsx`). The photo-specific corner-correction
 * overlay stays in `RecognitionConfirm.tsx` — it has no equivalent here.
 */
export default function BallPositionEditor({ boundary, widthMm, heightMm, balls, positions, onPositionsChange }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const boundaryXs = boundary.map((p) => p.x);
  const boundaryYs = boundary.map((p) => p.y);
  const margin = BALL_RADIUS_MM * 3;
  const minX = Math.min(...boundaryXs) - margin;
  const maxX = Math.max(...boundaryXs) + margin;
  const minY = Math.min(...boundaryYs) - margin;
  const maxY = Math.max(...boundaryYs) + margin;
  const flipK = minY + maxY;
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
  // (true-to-scale, much smaller) ball radius.
  const railDotRadius = (maxX - minX) * 0.006;

  /** Convert a pointer event's screen position into mm space — via the SVG's
   * own screen CTM (already accounts for viewBox scaling/responsive sizing),
   * then undoing the inner `<g>`'s Y-flip (self-inverse, so the same formula
   * applies both ways: `local = flipK - root`). */
  function clientToMm(clientX: number, clientY: number): Point | null {
    const svg = svgRef.current;
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
    onPositionsChange({
      ...positions,
      [id]: {
        x: clamp(mm.x, BALL_RADIUS_MM, widthMm - BALL_RADIUS_MM),
        y: clamp(mm.y, BALL_RADIUS_MM, heightMm - BALL_RADIUS_MM),
      },
    });
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

  return (
    <>
    <div className={styles.editorWrap}>
      <svg ref={svgRef} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className={styles.editorSvg}>
        <g transform={`translate(0, ${flipK}) scale(1, -1)`}>
          <polygon points={boundaryPoints} className={styles.editorTable} />

          {railDots.map((p, i) => (
            <circle key={`rail-${i}`} cx={p.x} cy={p.y} r={railDotRadius} className={styles.editorRailDot} />
          ))}

          {balls.map((ball) => {
            const pos = positions[ball.id];
            if (!pos) return null;
            return (
              <g key={ball.id}>
                {/* Larger invisible hit target — the true-to-scale ball
                 * circle below is too small to grab reliably with a finger. */}
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
      {balls.map((ball) => (
        <li key={ball.id} className={styles.legendItem}>
          <span className={styles.ballSwatch} style={{ background: BALL_DISPLAY_COLOR[ball.color] }} aria-hidden="true" />
          {BALL_LABEL[ball.color]}
        </li>
      ))}
    </ul>
    </>
  );
}
