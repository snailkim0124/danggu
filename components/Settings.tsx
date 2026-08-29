'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_SKILL_PROFILE,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_LABEL,
  type Settings as SettingsType,
  type SkillLevel,
  type TableSize,
} from '@/lib/types';
import styles from './Settings.module.css';

type LoadState = 'loading' | 'ready' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const DEFAULT_SETTINGS: SettingsType = {
  cueBallColor: 'white',
  tableSize: '중대',
  skillProfile: DEFAULT_SKILL_PROFILE,
};

const SKILL_LEVELS: SkillLevel[] = [1, 2, 3, 4, 5];

/**
 * Cue ball color + table size preset editor. GETs `/api/settings` on mount,
 * POSTs on every change (see `app/api/settings/route.ts`).
 */
export default function Settings() {
  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    let cancelled = false;

    fetch('/api/settings')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SettingsType) => {
        if (cancelled) return;
        setSettings(data);
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back to sane defaults so the UI is still usable if the API/DB isn't reachable.
        setLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function updateSettings(next: SettingsType) {
    setSettings(next);
    setSaveState('saving');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>설정</h2>

      {loadState === 'error' && (
        <p className={styles.warningBanner} role="alert">
          저장된 설정을 불러오지 못했습니다. 기본값을 표시하며, 변경 사항 저장도 실패할 수 있습니다.
        </p>
      )}

      <fieldset className={styles.group}>
        <legend>내 큐볼 색상</legend>
        <div className={styles.toggleRow}>
          <button
            type="button"
            className={`${styles.toggleButton} ${settings.cueBallColor === 'white' ? styles.toggleButtonActive : ''}`}
            aria-pressed={settings.cueBallColor === 'white'}
            onClick={() => updateSettings({ ...settings, cueBallColor: 'white' })}
          >
            흰공
          </button>
          <button
            type="button"
            className={`${styles.toggleButton} ${settings.cueBallColor === 'yellow' ? styles.toggleButtonActive : ''}`}
            aria-pressed={settings.cueBallColor === 'yellow'}
            onClick={() => updateSettings({ ...settings, cueBallColor: 'yellow' })}
          >
            노랑공
          </button>
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>테이블 규격</legend>
        <div className={styles.toggleRow}>
          {(['대대', '중대'] as TableSize[]).map((size) => (
            <button
              key={size}
              type="button"
              className={`${styles.toggleButton} ${settings.tableSize === size ? styles.toggleButtonActive : ''}`}
              aria-pressed={settings.tableSize === size}
              onClick={() => updateSettings({ ...settings, tableSize: size })}
            >
              {size}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend>내가 잘하는 샷</legend>
        <p className={styles.skillHint}>
          자신 있는 기술일수록 5에 가깝게 골라주세요 — 추천 샷의 우선순위에 반영됩니다.
        </p>
        {SKILL_CATEGORIES.map((category) => {
          const profile = settings.skillProfile ?? DEFAULT_SKILL_PROFILE;
          return (
            <div key={category} className={styles.skillRow}>
              <span className={styles.skillLabel}>{SKILL_CATEGORY_LABEL[category]}</span>
              <div className={styles.skillLevels} role="radiogroup" aria-label={SKILL_CATEGORY_LABEL[category]}>
                {SKILL_LEVELS.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={profile[category] === level}
                    className={`${styles.skillLevelButton} ${
                      profile[category] === level ? styles.skillLevelButtonActive : ''
                    }`}
                    onClick={() =>
                      updateSettings({
                        ...settings,
                        skillProfile: { ...profile, [category]: level },
                      })
                    }
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>

      <p className={styles.saveStatus} role="status">
        {saveState === 'saving' && '저장 중...'}
        {saveState === 'saved' && '저장됨'}
        {saveState === 'error' && '저장 실패 — 네트워크 상태를 확인해주세요'}
      </p>
    </div>
  );
}
