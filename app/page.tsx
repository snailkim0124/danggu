'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import PhotoUpload from '@/components/PhotoUpload';
import RecognitionConfirm from '@/components/RecognitionConfirm';
import ShotDiagram from '@/components/ShotDiagram';
import { DEFAULT_SKILL_PROFILE, type RecognitionResult, type Settings as SettingsType } from '@/lib/types';
import type { PathCalcRequest, PathCalcResponse, PixelDetection } from '@/lib/uiTypes';
import styles from './page.module.css';

type Step = 'upload' | 'confirm' | 'results';

const DEFAULT_SETTINGS: SettingsType = {
  cueBallColor: 'white',
  tableSize: '중대',
  skillProfile: DEFAULT_SKILL_PROFILE,
};

export default function Home() {
  const [step, setStep] = useState<Step>('upload');
  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [pixelDetection, setPixelDetection] = useState<(PixelDetection & { approximate?: boolean }) | null>(null);
  const [recognition, setRecognition] = useState<RecognitionResult | null>(null);
  const [pathCalc, setPathCalc] = useState<PathCalcResponse | null>(null);
  const [pathCalcLoading, setPathCalcLoading] = useState(false);
  const [pathCalcError, setPathCalcError] = useState<string | null>(null);

  // Load the user's saved cue-ball-color / table-size settings once, so both
  // the real /api/recognize call and the upload step's mock-data fallback use
  // the correct cue ball color for role assignment.
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: SettingsType) => setSettings(data))
      .catch(() => {
        /* keep defaults — Settings.tsx surfaces the load error on its own page */
      });
  }, []);

  function handleRecognized(url: string, result: RecognitionResult, pixels: PixelDetection & { approximate?: boolean }) {
    setPhotoUrl(url);
    setRecognition(result);
    setPixelDetection(pixels);
    setPathCalc(null);
    setPathCalcError(null);
    setStep('confirm');
  }

  async function handleConfirmed(corrected: RecognitionResult) {
    setRecognition(corrected);
    setPathCalcLoading(true);
    setPathCalcError(null);

    try {
      const body: PathCalcRequest = { recognition: corrected };
      const res = await fetch('/api/path-calc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`경로 계산 요청이 실패했습니다 (HTTP ${res.status})`);

      const data = (await res.json()) as PathCalcResponse;
      setPathCalc(data);
      setStep('results');
    } catch (err) {
      setPathCalcError(err instanceof Error ? err.message : '경로 계산 중 알 수 없는 오류가 발생했습니다');
    } finally {
      setPathCalcLoading(false);
    }
  }

  function handleRestart() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(null);
    setPixelDetection(null);
    setRecognition(null);
    setPathCalc(null);
    setPathCalcError(null);
    setStep('upload');
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.headerTitle}>당구 샷 가이드</h1>
        <Link href="/settings" className={styles.settingsLink}>
          설정
        </Link>
      </header>

      <main className={styles.main}>
        {step === 'upload' && <PhotoUpload settings={settings} onRecognized={handleRecognized} />}

        {step === 'confirm' && recognition && pixelDetection && photoUrl && (
          <RecognitionConfirm
            photoUrl={photoUrl}
            recognition={recognition}
            pixelDetection={pixelDetection}
            onConfirm={handleConfirmed}
            onBack={() => setStep('upload')}
          />
        )}

        {pathCalcLoading && (
          <p className={styles.statusMessage} role="status">
            경로 계산 중...
          </p>
        )}

        {pathCalcError && (
          <p className={styles.errorMessage} role="alert">
            {pathCalcError}
          </p>
        )}

        {step === 'results' && recognition && pathCalc && (
          <>
            <ShotDiagram
              table={recognition.table}
              balls={recognition.balls}
              shots={pathCalc.shots}
              fallback={pathCalc.fallback}
            />
            <button type="button" className={styles.restartButton} onClick={handleRestart}>
              다시 촬영하기
            </button>
          </>
        )}
      </main>
    </div>
  );
}
