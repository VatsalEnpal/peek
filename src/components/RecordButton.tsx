import type { ReactElement } from 'react';
/**
 * Mode A — Record button. Lives in the topbar; replaces the placeholder.
 *
 * Idle:      [ ● REC ]   — amber dot, faint until hovered.
 * Recording: [ ● 00:12 STOP ] — pulsing red dot + mono elapsed timer.
 *
 * The pulse keyframe is injected once via a module-scope <style> tag so this
 * component stays self-contained and tokens.css is untouched.
 */

import { useEffect, useState } from 'react';

import { useRecordingStore } from '../stores/recording';
import { useSessionStore } from '../stores/session';

const PULSE_STYLE_ID = 'peek-record-pulse-style';

function ensurePulseStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = PULSE_STYLE_ID;
  el.textContent = `
    @keyframes peek-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.8); }
    }
    .peek-record-dot-pulse {
      animation: peek-pulse 1.1s ease-in-out infinite;
    }
  `;
  document.head.appendChild(el);
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export function RecordButton(): ReactElement {
  const isRecording = useRecordingStore((s) => s.isRecording);
  const startTs = useRecordingStore((s) => s.startTs);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);

  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    ensurePulseStyle();
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return (): void => clearInterval(id);
  }, [isRecording]);

  const disabled = !selectedSessionId && !isRecording;

  const onClick = async (): Promise<void> => {
    if (isRecording) {
      await stopRecording();
      return;
    }
    if (!selectedSessionId) return;
    // Simple, velocity-preserving label flow: prompt once, trim, empty = empty.
    const raw = typeof window !== 'undefined' ? window.prompt('Label this recording:', '') : '';
    const label = (raw ?? '').trim();
    await startRecording(selectedSessionId, label);
  };

  const elapsedMs = startTs ? now - Date.parse(startTs) : 0;
  const label = isRecording ? 'stop' : 'rec';

  return (
    <button
      type="button"
      data-testid="record-button"
      aria-pressed={isRecording}
      aria-label={isRecording ? 'stop recording' : 'start recording'}
      onClick={(): void => {
        void onClick();
      }}
      disabled={disabled}
      className="peek-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 'var(--peek-fs-xs)',
        padding: '4px 10px',
        border: `1px solid ${isRecording ? 'var(--peek-bad)' : 'var(--peek-border)'}`,
        color: isRecording
          ? 'var(--peek-bad)'
          : disabled
            ? 'var(--peek-fg-faint)'
            : 'var(--peek-fg-dim)',
        background: isRecording ? 'rgba(232, 106, 106, 0.08)' : 'transparent',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'color 120ms ease-out, border-color 120ms ease-out',
      }}
    >
      <span
        data-testid={isRecording ? 'record-pulse' : 'record-dot'}
        className={isRecording ? 'peek-record-dot-pulse' : undefined}
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: isRecording ? 'var(--peek-bad)' : 'var(--peek-accent)',
          boxShadow: isRecording ? '0 0 8px rgba(232, 106, 106, 0.65)' : 'none',
        }}
      />
      {isRecording && (
        <span
          data-testid="record-elapsed"
          className="peek-num"
          style={{ fontSize: 'var(--peek-fs-xs)', letterSpacing: '0.04em' }}
        >
          {formatElapsed(elapsedMs)}
        </span>
      )}
      <span>{label}</span>
    </button>
  );
}
