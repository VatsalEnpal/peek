import type { ReactElement } from 'react';
/**
 * ImportWizard (L2.3).
 *
 * Flow:
 *   1. Modal opens → auto-kick `POST /api/import/preview` with default path
 *      `~/.claude/projects`.
 *   2. Preview renders as a checkbox list with size + mtime + slug-first label.
 *      "Select all" / "Select none" toggle is at the top. Every row starts
 *      selected so the common "import everything" path is one click.
 *   3. "Import N sessions" button calls `POST /api/import/commit` and shows a
 *      single spinner row while the pipeline runs. On success, the sessions
 *      list is refetched and the modal closes.
 *   4. Errors bubble up as an inline banner in the modal (red) — never a
 *      silent failure.
 *
 * Design invariants:
 *   - Dark default, monospace numerics, one accent color for the primary
 *     "Import" action and selected-row affordance.
 *   - Keyboard: Escape closes; form submit on Enter triggers the primary
 *     action (Import when something is selected, otherwise Preview).
 *   - Plaintext (nothing sensitive here) but we still avoid exposing raw
 *     preview payloads outside component state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiPost, ApiError } from '../lib/api';
import { useSessionStore } from '../stores/session';
import { truncate } from '../lib/format';

type PreviewSession = {
  id: string;
  label: string;
  slug?: string | null;
  /** Legacy field: used to be aliased to totalTokens. Kept for back-compat. */
  size?: number;
  sizeBytes?: number | null;
  mtime?: string | null;
  latestTs?: string | null;
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

/** Format a byte count as MB / KB / B with a single decimal. */
export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a timestamp as "Nm ago" / "Nh ago" / "Nd ago" or fall back to ISO. */
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso || typeof iso !== 'string') return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Slug-first label per mockup. Fallback to 8-char id prefix. */
export function previewLabel(s: PreviewSession): string {
  if (typeof s.slug === 'string' && s.slug.length > 0) return s.slug;
  if (typeof s.label === 'string' && s.label.length > 0) {
    return truncate(s.label, 40);
  }
  return s.id.slice(0, 8);
}

export function ImportDialog({ open, onClose }: Props): ReactElement | null {
  const [path, setPath] = useState<string>(DEFAULT_PATH);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<false | 'preview' | 'commit'>(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const autoPreviewed = useRef<boolean>(false);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);

  // Reset transient state on each open, then auto-kick a preview so the user
  // sees candidate sessions immediately rather than having to click Preview.
  useEffect(() => {
    if (!open) {
      autoPreviewed.current = false;
      return;
    }
    setPreview(null);
    setSelected(new Set());
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

  const runPreview = useCallback(async (): Promise<void> => {
    setBusy('preview');
    setError(null);
    setToast(null);
    try {
      const result = await apiPost<PreviewResult>('/api/import/preview', { path });
      setPreview(result);
      // Default: everything selected — common case is "import everything".
      setSelected(new Set(result.sessions.map((s) => s.id)));
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
  }, [path]);

  // Kick the first preview on open. We do this in a separate effect so changes
  // to `path` don't re-auto-preview (user has to hit Preview again explicitly).
  useEffect(() => {
    if (!open || autoPreviewed.current) return;
    autoPreviewed.current = true;
    void runPreview();
  }, [open, runPreview]);

  const runCommit = useCallback(async (): Promise<void> => {
    setBusy('commit');
    setError(null);
    setToast(null);
    try {
      // Note: the server currently imports every session at `path`. The
      // `sessionIds` body is an advisory hint — the server may or may not
      // honor it in v0.2 (added for forward-compat with selective-commit).
      const result = await apiPost<PreviewResult>('/api/import/commit', {
        path,
        sessionIds: Array.from(selected),
      });
      setToast(`imported ${result.sessions.length} session(s)`);
      await fetchSessions();
      // Close on success so the user lands back on a fresh landing list.
      onClose();
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
  }, [path, selected, fetchSessions, onClose]);

  const allIds = useMemo(() => (preview?.sessions ?? []).map((s) => s.id), [preview]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const noneSelected = selected.size === 0;

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  };

  if (!open) return null;

  const importCount = selected.size;
  const importDisabled = busy !== false || noneSelected;

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
          minWidth: 560,
          width: 720,
          maxWidth: '90vw',
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
            Import sessions
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

        <div
          style={{
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflow: 'hidden',
            flex: 1,
            minHeight: 0,
          }}
        >
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
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                data-testid="import-path"
                value={path}
                onChange={(e): void => setPath(e.target.value)}
                onKeyDown={(e): void => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runPreview();
                  }
                }}
                style={{
                  background: 'var(--peek-surface-2)',
                  color: 'var(--peek-fg)',
                  border: '1px solid var(--peek-border)',
                  padding: '6px 8px',
                  fontFamily: 'var(--peek-font-mono)',
                  fontSize: 'var(--peek-fs-sm)',
                  flex: 1,
                  outline: 'none',
                }}
              />
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
                {busy === 'preview' ? 'scanning…' : 'Rescan'}
              </button>
            </div>
          </label>

          {/* Select-all toggle + count summary — appears only when preview loaded. */}
          {preview !== null && preview.sessions.length > 0 && (
            <div
              data-testid="import-select-bar"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '4px 2px',
                borderBottom: '1px solid var(--peek-border)',
              }}
            >
              <button
                type="button"
                data-testid="import-select-all"
                onClick={toggleAll}
                className="peek-mono"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--peek-accent)',
                  fontSize: 'var(--peek-fs-xs)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                  padding: '2px 0',
                }}
              >
                {allSelected ? 'select none' : 'select all'}
              </button>
              <span
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  letterSpacing: '0.06em',
                }}
              >
                {selected.size} / {preview.sessions.length} selected
              </span>
            </div>
          )}

          {/* Preview list */}
          <div
            data-testid="import-preview-list"
            style={{
              border: '1px solid var(--peek-border)',
              minHeight: 140,
              maxHeight: 360,
              overflow: 'auto',
              flex: 1,
            }}
          >
            {busy === 'preview' && preview === null ? (
              <div
                data-testid="import-preview-loading"
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                scanning {path}…
              </div>
            ) : preview === null ? (
              <div
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                rescan to list candidate sessions
              </div>
            ) : preview.sessions.length === 0 ? (
              <div
                data-testid="import-preview-empty"
                className="peek-mono"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  padding: 16,
                  textAlign: 'center',
                }}
              >
                no sessions found at that path
              </div>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                }}
              >
                {preview.sessions.map((s) => {
                  const isChecked = selected.has(s.id);
                  return (
                    <li
                      key={s.id}
                      data-testid={`import-preview-row-${s.id}`}
                      style={{
                        padding: '8px 12px',
                        borderBottom: '1px solid var(--peek-border)',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr auto auto',
                        gap: 12,
                        alignItems: 'center',
                        fontSize: 'var(--peek-fs-sm)',
                        cursor: 'pointer',
                        background: isChecked ? 'var(--peek-surface-2)' : 'transparent',
                        borderLeft: isChecked
                          ? '2px solid var(--peek-accent)'
                          : '2px solid transparent',
                      }}
                      onClick={(): void => toggleSelect(s.id)}
                    >
                      <input
                        type="checkbox"
                        data-testid={`import-checkbox-${s.id}`}
                        aria-label={`select ${previewLabel(s)}`}
                        checked={isChecked}
                        onChange={(): void => toggleSelect(s.id)}
                        onClick={(e): void => e.stopPropagation()}
                        style={{
                          accentColor: 'var(--peek-accent)',
                          cursor: 'pointer',
                        }}
                      />
                      <span
                        className="peek-mono"
                        style={{
                          color: 'var(--peek-fg)',
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {previewLabel(s)}
                      </span>
                      <span
                        className="peek-num peek-faint"
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          fontSize: 'var(--peek-fs-xs)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatBytes(s.sizeBytes)}
                      </span>
                      <span
                        className="peek-mono peek-faint"
                        style={{
                          fontSize: 'var(--peek-fs-xs)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatAgo(s.mtime)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error !== null && (
            <div
              data-testid="import-error"
              role="alert"
              className="peek-mono"
              style={{
                color: 'var(--peek-bad)',
                fontSize: 'var(--peek-fs-xs)',
                border: '1px solid var(--peek-bad)',
                background: 'rgba(232, 106, 106, 0.08)',
                padding: '8px 12px',
              }}
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
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              onClick={onClose}
              className="peek-mono"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--peek-border)',
                color: 'var(--peek-fg-dim)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="import-commit-btn"
              onClick={(): void => {
                void runCommit();
              }}
              disabled={importDisabled}
              className="peek-mono"
              style={{
                padding: '6px 14px',
                background: importDisabled ? 'var(--peek-surface-2)' : 'var(--peek-accent)',
                border: `1px solid ${importDisabled ? 'var(--peek-border)' : 'var(--peek-accent)'}`,
                color: importDisabled ? 'var(--peek-fg-faint)' : 'var(--peek-bg)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: importDisabled ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              {busy === 'commit'
                ? `importing ${importCount}…`
                : importCount === 0
                  ? 'import'
                  : importCount === 1
                    ? 'import 1 session'
                    : `import ${importCount} sessions`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
