import type { ReactElement } from 'react';
/**
 * Minimum-viable Import dialog.
 *
 * Checker BLOCKING finding: first-time users had no UI path to import
 * sessions from `~/.claude/projects/` — import was CLI-only. This dialog
 * gives a real, keyboard-accessible way to run a preview and commit.
 *
 * Full ImportWizard polish (per-session selection, diff preview, SSE
 * progress, drift warnings) is tracked as L2.3. This is the unblock.
 */

import { useEffect, useRef, useState } from 'react';

import { apiPost, ApiError } from '../lib/api';
import { useSessionStore } from '../stores/session';

type PreviewSession = {
  id: string;
  label: string;
  turnCount: number;
  totalTokens: number;
};

type PreviewResult = {
  sessions: PreviewSession[];
  driftWarnings?: unknown[];
};

type Props = {
  open: boolean;
  onClose: () => void;
};

const DEFAULT_PATH = '~/.claude/projects';

export function ImportDialog({ open, onClose }: Props): ReactElement | null {
  const [path, setPath] = useState<string>(DEFAULT_PATH);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState<false | 'preview' | 'commit'>(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);

  // Reset state whenever the dialog re-opens so stale previews don't linger.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setToast(null);
    setBusy(false);
  }, [open]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runPreview = async (): Promise<void> => {
    setBusy('preview');
    setError(null);
    setToast(null);
    try {
      const result = await apiPost<PreviewResult>('/api/import/preview', { path });
      setPreview(result);
      if (result.sessions.length === 0) {
        setToast('no sessions found at that path');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`preview failed: ${err.message}`);
      } else if (err instanceof Error) {
        setError(`preview failed: ${err.message}`);
      } else {
        setError('preview failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async (): Promise<void> => {
    setBusy('commit');
    setError(null);
    setToast(null);
    try {
      const result = await apiPost<PreviewResult>('/api/import/commit', { path });
      setToast(`imported ${result.sessions.length} session(s)`);
      // Refresh the sidebar so the freshly-imported sessions appear.
      await fetchSessions();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`import failed: ${err.message}`);
      } else if (err instanceof Error) {
        setError(`import failed: ${err.message}`);
      } else {
        setError('import failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="import-dialog-backdrop"
      role="presentation"
      onClick={(e): void => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        data-testid="import-dialog"
        style={{
          background: 'var(--peek-surface)',
          border: '1px solid var(--peek-border)',
          minWidth: 520,
          maxWidth: 720,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--peek-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            id="import-dialog-title"
            className="peek-mono"
            style={{
              fontSize: 'var(--peek-fs-sm)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--peek-fg)',
            }}
          >
            Import from ~/.claude/projects
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            data-testid="import-dialog-close"
            className="peek-mono"
            style={{
              background: 'transparent',
              border: '1px solid var(--peek-border)',
              color: 'var(--peek-fg-dim)',
              padding: '2px 8px',
              fontSize: 'var(--peek-fs-xs)',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </header>

        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label
            className="peek-mono"
            style={{
              fontSize: 'var(--peek-fs-xs)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--peek-fg-dim)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            Path
            <input
              type="text"
              data-testid="import-path"
              value={path}
              onChange={(e): void => setPath(e.target.value)}
              style={{
                background: 'var(--peek-surface-2)',
                color: 'var(--peek-fg)',
                border: '1px solid var(--peek-border)',
                padding: '6px 8px',
                fontFamily: 'var(--peek-font-mono)',
                fontSize: 'var(--peek-fs-sm)',
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-testid="import-preview-btn"
              onClick={(): void => {
                void runPreview();
              }}
              disabled={busy !== false}
              className="peek-mono"
              style={{
                padding: '6px 12px',
                background: 'var(--peek-surface-2)',
                border: '1px solid var(--peek-border)',
                color: 'var(--peek-fg)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: busy !== false ? 'wait' : 'pointer',
              }}
            >
              {busy === 'preview' ? 'previewing…' : 'Preview'}
            </button>
            <button
              type="button"
              data-testid="import-commit-btn"
              onClick={(): void => {
                void runCommit();
              }}
              disabled={busy !== false}
              className="peek-mono"
              style={{
                padding: '6px 12px',
                background: 'var(--peek-accent)',
                border: '1px solid var(--peek-accent)',
                color: 'var(--peek-bg)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: busy !== false ? 'wait' : 'pointer',
              }}
            >
              {busy === 'commit' ? 'importing…' : 'Import selected'}
            </button>
          </div>

          {error !== null && (
            <div
              data-testid="import-error"
              className="peek-mono"
              style={{ color: 'var(--peek-bad)', fontSize: 'var(--peek-fs-xs)' }}
            >
              {error}
            </div>
          )}
          {toast !== null && (
            <div
              data-testid="import-toast"
              className="peek-mono"
              style={{ color: 'var(--peek-fg-dim)', fontSize: 'var(--peek-fs-xs)' }}
            >
              {toast}
            </div>
          )}

          <div
            data-testid="import-preview-list"
            style={{
              border: '1px solid var(--peek-border)',
              minHeight: 120,
              maxHeight: 280,
              overflow: 'auto',
            }}
          >
            {preview === null ? (
              <div
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                run preview to list candidate sessions
              </div>
            ) : preview.sessions.length === 0 ? (
              <div
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                no sessions at that path
              </div>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                }}
              >
                {preview.sessions.map((s) => (
                  <li
                    key={s.id}
                    data-testid={`import-preview-row-${s.id}`}
                    style={{
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--peek-border)',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: 12,
                      alignItems: 'center',
                      fontSize: 'var(--peek-fs-sm)',
                    }}
                  >
                    <span style={{ color: 'var(--peek-fg)' }}>{s.label}</span>
                    <span
                      className="peek-num peek-dim"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {s.turnCount} turns
                    </span>
                    <span
                      className="peek-num"
                      style={{
                        color: 'var(--peek-accent)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {s.totalTokens.toLocaleString('en-US')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
