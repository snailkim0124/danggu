'use client';

import { useRef, useState } from 'react';
import type { RecognitionResult, Settings } from '@/lib/types';
import type { RecognizeOutput } from '@/lib/vision';
import type { PixelDetection } from '@/lib/uiTypes';
import { approximatePixelDetection, mockRecognitionResult } from '@/lib/mockData';
import styles from './PhotoUpload.module.css';

interface Props {
  settings: Settings;
  onRecognized: (
    photoUrl: string,
    recognition: RecognitionResult,
    pixelDetection: PixelDetection & { approximate?: boolean }
  ) => void;
}

type Status = 'idle' | 'recognizing' | 'error';

/** Reads an image file's natural pixel dimensions via a throwaway <img>. */
function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다'));
    img.src = url;
  });
}

/**
 * Mobile-friendly photo capture/upload. Posts the photo to `/api/recognize`
 * (lib/vision), which returns a `RecognizeOutput` (mm-space `RecognitionResult`
 * + pixel-space `PixelDetection` for the confirm screen's photo overlay). If
 * that request fails for any reason, offers a clearly-labeled mock-data
 * fallback so the rest of the flow stays testable end to end.
 */
export default function PhotoUpload({ settings, onRecognized }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setError(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(selected);
    });
  }

  async function runRecognition(useMock: boolean) {
    if (!previewUrl) return;
    setStatus('recognizing');
    setError(null);

    try {
      const { width, height } = await readImageSize(previewUrl);

      if (useMock) {
        const recognition = mockRecognitionResult(settings);
        const pixelDetection = approximatePixelDetection(recognition, width, height);
        onRecognized(previewUrl, recognition, pixelDetection);
        return;
      }

      const formData = new FormData();
      formData.append('image', file as File);
      formData.append('tableSize', settings.tableSize);
      formData.append('cueBallColor', settings.cueBallColor);

      const res = await fetch('/api/recognize', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `인식 요청이 실패했습니다 (HTTP ${res.status})`);
      }

      const data = (await res.json()) as RecognizeOutput;
      onRecognized(previewUrl, data.recognition, data.pixelDetection);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : '인식 중 알 수 없는 오류가 발생했습니다');
    }
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>당구대 사진 업로드</h2>
      <p className={styles.hint}>테이블 전체와 공 4개가 보이도록 찍어주세요. 비스듬한 각도도 괜찮습니다.</p>

      <div className={styles.previewBox}>
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not an optimizable remote asset
          <img src={previewUrl} alt="업로드한 당구대 사진 미리보기" className={styles.previewImage} />
        ) : (
          <span className={styles.placeholder}>사진 미리보기</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className={styles.fileInput}
        aria-label="당구대 사진 선택 또는 촬영"
      />

      {status === 'recognizing' && (
        <p className={styles.statusMessage} role="status">
          인식 중... (최대 몇 초 소요될 수 있어요)
        </p>
      )}

      {status === 'error' && error && (
        <div className={styles.errorBox} role="alert">
          <p>{error}</p>
          <button type="button" className={styles.secondaryButton} onClick={() => runRecognition(true)}>
            샘플 데이터로 계속 진행 (인식 서버 연동 전 테스트용)
          </button>
        </div>
      )}

      <button
        type="button"
        className={styles.primaryButton}
        disabled={!file || status === 'recognizing'}
        onClick={() => runRecognition(false)}
      >
        인식 시작
      </button>
    </div>
  );
}
