import { formatThicknessFraction, tipOffsetToUnitPoint } from '@/lib/aimVisual';
import styles from './CueBallAim.module.css';

interface Props {
  /** Cue ball tip-strike offset; `undefined`/center for direct/bank shots. */
  tipOffset?: { vertical: number; horizontal: number };
  /** `Shot.aimTarget.thickness`, 0 (thinnest) .. 1 (full/center). */
  thickness: number;
}

const R = 40; // cue-ball circle radius, SVG units
const DOT_R = 6;

/**
 * Visual aid for 당점(tip-strike point)/두께(thickness) — 문제점 #2: these were
 * shown only as raw numbers, which players can't translate into "where do I
 * actually put my cue tip". Draws a virtual cue ball with a dot at the tip
 * contact point and the thickness as a fraction ("1/2", "3/4") rather than a
 * percentage.
 */
export default function CueBallAim({ tipOffset, thickness }: Props) {
  const dot = tipOffsetToUnitPoint(tipOffset);
  const fraction = formatThicknessFraction(thickness);
  const isCenter = dot.x === 0 && dot.y === 0;

  return (
    <div className={styles.container}>
      <svg viewBox="-50 -50 100 100" className={styles.svg} role="img" aria-label={`당점: ${isCenter ? '중앙' : '중앙에서 벗어남'}, 두께: ${fraction.label}`}>
        <circle cx={0} cy={0} r={R} className={styles.ball} />
        {/* Crosshair through centre, for reading the offset at a glance. */}
        <line x1={-R} y1={0} x2={R} y2={0} className={styles.crosshair} />
        <line x1={0} y1={-R} x2={0} y2={R} className={styles.crosshair} />
        <circle
          cx={dot.x * R * 0.85}
          cy={dot.y * R * 0.85}
          r={DOT_R}
          className={isCenter ? styles.dotCenter : styles.dot}
        />
      </svg>
      <div className={styles.labels}>
        <span className={styles.labelRow}>
          <span className={styles.labelKey}>당점</span>
          <span className={styles.labelValue}>{isCenter ? '중앙(센터)' : '표시된 점 위치'}</span>
        </span>
        <span className={styles.labelRow}>
          <span className={styles.labelKey}>두께</span>
          <span className={styles.labelValue}>{fraction.label}</span>
        </span>
      </div>
    </div>
  );
}
