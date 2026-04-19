import type { ReactElement } from 'react';
/**
 * Record button — L3.5.
 *
 * Click behaviour:
 *   1. If already recording → stop immediately (fire-and-forget PATCH).
 *   2. Otherwise open an inline label prompt pre-filled with the most recent
 *      user_prompt span's text (one-line, truncated). User types/edits → Enter
 *      submits; Esc cancels.
 *   3. On submit we POST `/api/bookmarks` with
 *        `{ sessionId, spanId?, label, source: "record" }`
 *      via the recording store, which flips `isRecording` on success.
 *
 * Visual states:
 *   - Idle:        [ ● rec ]  amber dot
 *   - Recording:   [ ● 00:12 stop ] pulsing red dot + MM:SS mono timer
 *
 * Cmd+Shift+R hotkey lives in SessionDetailPage — it calls the same helper
 * (directly invoking `useRecordingStore.startRecording`). The in-app prompt
 * UX only fires on pointer click; keyboard path uses a native window.prompt
 * so power users never leave the keyboard.
 */

import { useEffect, useRef, useState } from 'react';

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

/**
 * Pull the most-recent user_prompt span's text from the store.
 * Exported so tests can exercise the same lookup.
 */
export function lastUserPromptLabel(
  events: ReadonlyArray<{ kind?: string; type?: string; name?: string }>
): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === 'span' && e.type === 'user_prompt' && typeof e.name === 'string') {
      // One-line, trimmed, bounded so we don't paste a 1k-char prompt.
      return e.name.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  return '';
}

/** Find the most-recent span.id so the bookmark carries a stable spanId anchor. */
function lastSpanId(
  events: ReadonlyArray<{ kind?: string; id?: string; startTs?: string }>
): string | null {
  let bestTs = '';
  let bestId: string | null = null;
  for (const e of events) {
    if (e.kind !== 'span' || typeof e.id !== 'string') continue;
    const ts = e.startTs ?? '';
    if (ts >= bestTs) {
      bestTs = ts;
      bestId = e.id;
    }
  }
  return bestId;
}

export function RecordButton(): ReactElement {
  const isRecording = useRecordingStore((s) => s.isRecording);
  const startTs = useRecordingStore((s) => s.startTs);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const events = useSessionStore((s) => s.events);

  const [now, setNow] = useState<number>(() => Date.now());
  const [promptOpen, setPromptOpen] = useState<boolean>(false);
  const [labelDraft, setLabelDraft] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ensurePulseStyle();
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return (): void => clearInterval(id);
  }, [isRecording]);

  // Auto-focus the input when the prompt opens.
  useEffect(() => {
    if (promptOpen && inputRef.current) inputRef.current.focus();
  }, [promptOpen]);

  const disabled = !selectedSessionId && !isRecording;

  const openPrompt = (): void => {
    const prefill = lastUserPromptLabel(
      events as unknown as ReadonlyArray<Record<string, unknown>>
    );
    setLabelDraft(prefill);
    setPromptOpen(true);
  };

  const submitPrompt = async (): Promise<void> => {
    if (!selectedSessionId) {
      setPromptOpen(false);
      return;
    }
    const label = labelDraft.trim();
    const spanId =
      lastSpanId(events as unknown as ReadonlyArray<Record<string, unknown>>) ?? undefined;
    setPromptOpen(false);
    // The recording store composes the POST body — it always sets
    // `source: "record"` and attaches startTs. We pass spanId via the
    // store-extension contract below.
    await startRecording(selectedSessionId, label, spanId);
  };

  const cancelPrompt = (): void => {
    setPromptOpen(false);
    setLabelDraft('');
  };

  const onClick = async (): Promise<void> => {
    if (isRecording) {
      await stopRecording();
      return;
    }
    if (!selectedSessionId) return;
    // Open the inline label prompt rather than posting immediately.
    openPrompt();
  };

  const elapsedMs = startTs ? now - Date.parse(startTs) : 0;
  const label = isRecording ? 'stop' : 'rec';

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
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
          padding: '6px 14px',
          border: `1px solid ${isRecording ? 'var(--peek-bad)' : 'var(--peek-border)'}`,
          color: isRecording
            ? 'var(--peek-bad)'
            : disabled
              ? 'var(--peek-fg-faint)'
              : 'var(--peek-fg)',
          background: isRecording ? 'rgba(232, 106, 106, 0.08)' : 'transparent',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
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

      {promptOpen && (
        <div
          data-testid="record-label-prompt"
          role="dialog"
          aria-label="label this recording"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 30,
            minWidth: 320,
            padding: 12,
            background: 'var(--peek-surface-2)',
            border: '1px solid var(--peek-border)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <label
            className="peek-mono"
            htmlFor="peek-record-label-input"
            style={{
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--peek-fg-faint)',
            }}
          >
            label this recording
          </label>
          <input
            id="peek-record-label-input"
            ref={inputRef}
            data-testid="record-label-input"
            type="text"
            value={labelDraft}
            onChange={(e): void => setLabelDraft(e.target.value)}
            onKeyDown={(e): void => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitPrompt();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelPrompt();
              }
            }}
            className="peek-mono"
            style={{
              background: 'var(--peek-bg)',
              border: '1px solid var(--peek-border)',
              color: 'var(--peek-fg)',
              padding: '6px 8px',
              fontSize: 'var(--peek-fs-sm)',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              data-testid="record-label-cancel"
              onClick={cancelPrompt}
              className="peek-mono"
              style={{
                fontSize: 10,
                padding: '4px 8px',
                border: '1px solid var(--peek-border)',
                color: 'var(--peek-fg-faint)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="record-label-submit"
              onClick={(): void => {
                void submitPrompt();
              }}
              className="peek-mono"
              style={{
                fontSize: 10,
                padding: '4px 8px',
                border: '1px solid var(--peek-accent)',
                color: 'var(--peek-accent)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              record
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
