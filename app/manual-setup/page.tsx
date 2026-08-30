'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import BallPositionEditor from '@/components/BallPositionEditor';
import ShotDiagram from '@/components/ShotDiagram';
import { BALL_LABEL } from '@/lib/ballVisuals';
import {
  DEFAULT_MANUAL_RATIO_POSITIONS,
  MANUAL_BALL_KEYS,
  buildManualRecognitionResult,
  manualBallColor,
  manualTableBoundary,
  mmToRatio,
  ratioToMm,
  type ManualBallKey,
} from '@/lib/manualSetup';
import { DEFAULT_SKILL_PROFILE, TABLE_DIMENSIONS_MM, type Point, type Settings as SettingsType } from '@/lib/types';
import type { PathCalcRequest, PathCalcResponse } from '@/lib/uiTypes';
import sharedStyles from '../page.module.css';
import styles from './page.module.css';

const DEFAULT_SETTINGS: SettingsType = {
  cueBallColor: 'white',
  tableSize: '중대',
  skillProfile: DEFAULT_SKILL_PROFILE,
};

/**
 * 수동 배치 모드 — Capture(사진 촬영)와 Vision Recognition(자동 인식) 단계를
 * 완전히 건너뛰고, 가상 2D 테이블 위에 공 4개를 직접 배치해 곧바로 Path
 * Calculation(`lib/pathcalc`) + Result Visualization(`ShotDiagram`)을 그대로
 * 재사용해 확인하는 새 진입점. `RecognitionResult`의 `confidence`/
 * `needsManualCorrection`은 여기서 계산되지 않고 "인식 자체가 없었다"는
 * 정직한 상수값(1 / false)으로 고정된다 — `lib/manualSetup.ts` 참고.
 *
 * 공 위치의 단일 진실 소스는 **비율 좌표**(0..1, `docs/testing/play-gate-checklist.md`
 * §3과 동일 규약) — 테이블 규격이 바뀌어도(설정 변경) 재환산할 필요가 없고,
 * 지오메트릭 게이트/플레이 게이트에 이미 문서화된 배치를 숫자 입력으로 그대로
 * 재현할 수 있다. mm 좌표는 드래그 편집기·경로 계산 호출 시점에만 파생된다.
 */
export default function ManualSetupPage() {
  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [ratioPositions, setRatioPositions] = useState<Record<ManualBallKey, Point>>(DEFAULT_MANUAL_RATIO_POSITIONS);
  const [pathCalc, setPathCalc] = useState<PathCalcResponse | null>(null);
  const [pathCalcLoading, setPathCalcLoading] = useState(false);
  const [pathCalcError, setPathCalcError] = useState<string | null>(null);

  // Load the user's saved cue-ball-color / table-size settings once — same
  // fetch app/page.tsx does for the photo flow, so both entry points always
  // agree on which ball is the cue ball.
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SettingsType) => setSettings(data))
      .catch(() => {
        /* keep defaults — Settings.tsx surfaces the load error on its own page */
      })
      .finally(() => setSettingsLoaded(true));
  }, []);

  const { widthMm, heightMm } = TABLE_DIMENSIONS_MM[settings.tableSize];
  const boundary = useMemo(() => manualTableBoundary(widthMm, heightMm), [widthMm, heightMm]);

  const mmPositions = useMemo(
    () =>
      Object.fromEntries(MANUAL_BALL_KEYS.map((key) => [key, ratioToMm(ratioPositions[key], widthMm, heightMm)])) as Record<
        ManualBallKey,
        Point
      >,
    [ratioPositions, widthMm, heightMm],
  );

  const editorBalls = MANUAL_BALL_KEYS.map((key) => ({ id: key, color: manualBallColor(key, settings.cueBallColor) }));

  function handleEditorPositionsChange(nextMm: Record<string, Point>) {
    setRatioPositions((prev) => {
      const next = { ...prev };
      for (const key of MANUAL_BALL_KEYS) {
        const pos = nextMm[key];
        if (pos) next[key] = mmToRatio(pos, widthMm, heightMm);
      }
      return next;
    });
  }

  function handleRatioInputChange(key: ManualBallKey, axis: 'x' | 'y', value: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    setRatioPositions((prev) => ({
      ...prev,
      [key]: { ...prev[key], [axis]: Math.min(1, Math.max(0, parsed)) },
    }));
  }

  async function handleCompute() {
    setPathCalcLoading(true);
    setPathCalcError(null);
    setPathCalc(null);

    try {
      const recognition = buildManualRecognitionResult(settings, mmPositions);
      const body: PathCalcRequest = { recognition };
      const res = await fetch('/api/path-calc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`경로 계산 요청이 실패했습니다 (HTTP ${res.status})`);

      const data = (await res.json()) as PathCalcResponse;
      setPathCalc(data);
    } catch (err) {
      setPathCalcError(err instanceof Error ? err.message : '경로 계산 중 알 수 없는 오류가 발생했습니다');
    } finally {
      setPathCalcLoading(false);
    }
  }

  const recognitionForDiagram = pathCalc ? buildManualRecognitionResult(settings, mmPositions) : null;

  return (
    <div className={sharedStyles.page}>
      <header className={sharedStyles.header}>
        <Link href="/" className={sharedStyles.backLink}>
          ← 뒤로
        </Link>
        <h1 className={sharedStyles.headerTitle}>수동 배치</h1>
      </header>

      <main className={sharedStyles.main}>
        <div className={styles.container}>
          <p className={styles.hint}>
            사진을 찍지 않고, 공 4개를 직접 배치해 추천 샷을 바로 확인합니다. 좌표는 지오메트릭 게이트/플레이
            게이트 문서와 같은 비율 좌표(0~1, 쿠션 안쪽 기준)를 씁니다 — 숫자를 직접 입력해 정확한 배치를 재현할
            수도 있습니다.
          </p>

          <div className={styles.settingsSummary}>
            <span>
              큐볼: <strong>{settings.cueBallColor === 'white' ? '흰공' : '노랑공'}</strong>
            </span>
            <span>
              테이블: <strong>{settings.tableSize}</strong>
            </span>
            <Link href="/settings" className={styles.settingsLink}>
              설정에서 변경
            </Link>
          </div>
          {!settingsLoaded && (
            <p className={sharedStyles.statusMessage} role="status">
              설정을 불러오는 중...
            </p>
          )}

          <BallPositionEditor
            boundary={boundary}
            widthMm={widthMm}
            heightMm={heightMm}
            balls={editorBalls}
            positions={mmPositions}
            onPositionsChange={handleEditorPositionsChange}
          />

          <ul className={styles.ratioInputs}>
            {MANUAL_BALL_KEYS.map((key) => (
              <li key={key} className={styles.ratioInputRow}>
                <span className={styles.ratioInputLabel}>{BALL_LABEL[manualBallColor(key, settings.cueBallColor)]}</span>
                <label className={styles.ratioField}>
                  x
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={ratioPositions[key].x.toFixed(2)}
                    onChange={(e) => handleRatioInputChange(key, 'x', e.target.value)}
                  />
                </label>
                <label className={styles.ratioField}>
                  y
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={ratioPositions[key].y.toFixed(2)}
                    onChange={(e) => handleRatioInputChange(key, 'y', e.target.value)}
                  />
                </label>
              </li>
            ))}
          </ul>

          <button type="button" className={styles.primaryButton} onClick={handleCompute} disabled={pathCalcLoading}>
            {pathCalcLoading ? '경로 계산 중...' : '경로 계산'}
          </button>

          {pathCalcError && (
            <p className={sharedStyles.errorMessage} role="alert">
              {pathCalcError}
            </p>
          )}
        </div>

        {pathCalc && recognitionForDiagram && (
          <ShotDiagram
            table={recognitionForDiagram.table}
            balls={recognitionForDiagram.balls}
            shots={pathCalc.shots}
            fallback={pathCalc.fallback}
          />
        )}
      </main>
    </div>
  );
}
