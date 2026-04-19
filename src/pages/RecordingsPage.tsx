/**
 * Level-1 landing page (v0.3) — the recordings list.
 *
 * Replaces the legacy SessionsPage at `/`. Per the spec, Peek is a recorder,
 * not a viewer — only rows explicitly created with `/peek_start` surface
 * here. The table layout mirrors the "Ctrl+O" editorial tone:
 *
 *   │ Name            │ Started │ Duration │ Tools │ API │ Tokens │ Status    │
 *
 * Live recordings pin to the top with a pulsing amber dot. Empty state
 * nudges the user to type `/peek_start NAME` in their Claude Code session.
 *
 * SSE wiring lives in the useLiveRecordings hook; the store owns the canonical
 * list. The page is pure: pick rows, sort, render. Sorting matches the
 * server-side ordering rule so live merges from SSE land in the right place.
 */

import { useEffect, useMemo, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useRecordingsStore, type RecordingSummary } from '../stores/recordings';
import { useLiveRecordings } from '../lib/useLiveRecordings';

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatStarted(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  ) {
    return `yesterday ${hh}:${mm}`;
  }
  const yy = String(d.getFullYear()).slice(-2);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mo}-${dd} ${hh}:${mm}`;
}

/** Stable order: open first (status='recording'), then by startTs desc. */
function order(a: RecordingSummary, b: RecordingSummary): number {
  const aOpen = a.status === 'recording' ? 1 : 0;
  const bOpen = b.status === 'recording' ? 1 : 0;
  if (aOpen !== bOpen) return bOpen - aOpen;
  if (a.startTs !== b.startTs) return a.startTs < b.startTs ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function RecordingsPage(): ReactElement {
  const recordings = useRecordingsStore((s) => s.recordings);
  const loading = useRecordingsStore((s) => s.loading);
  const error = useRecordingsStore((s) => s.error);
  const fetchRecordings = useRecordingsStore((s) => s.fetchRecordings);

  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  // Subscribe to live SSE updates — hook is a no-op in test env where
  // EventSource is undefined, so unit tests don't need to mock it.
  useLiveRecordings();

  const sorted = useMemo(() => [...recordings].sort(order), [recordings]);
  const openCount = sorted.filter((r) => r.status === 'recording').length;
  const totalTokens = sorted.reduce((n, r) => n + r.totalTokens, 0);

  return (
    <div
      data-testid="recordings-page"
      style={{
        minHeight: '100dvh',
        background: 'var(--peek-bg)',
        color: 'var(--peek-fg)',
        fontFamily: 'var(--peek-font-mono)',
      }}
    >
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: 40 }}>
        <div
          data-testid="recordings-frame"
          style={{
            border: '1px solid var(--peek-border)',
            background: 'var(--peek-surface)',
          }}
        >
          {/* ── topbar ── */}
          <header
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 24,
              padding: '18px 24px 14px',
              borderBottom: '1px solid var(--peek-border)',
            }}
          >
            <span
              data-testid="peek-brand"
              style={{
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: 'var(--peek-accent)',
                fontSize: 'var(--peek-fs-md)',
              }}
            >
              PEEK
            </span>
            <span
              style={{
                color: 'var(--peek-fg-faint)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.04em',
              }}
            >
              a recorder for your agents
            </span>
            <span style={{ flex: 1 }} />
            <Link
              to="/sessions"
              data-testid="recordings-legacy-link"
              style={{
                color: 'var(--peek-fg-faint)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'lowercase',
                border: '1px solid var(--peek-border)',
                padding: '3px 8px',
                textDecoration: 'none',
              }}
            >
              all sessions →
            </Link>
          </header>

          {/* ── meta line ── */}
          <div
            data-testid="recordings-meta"
            style={{
              padding: '12px 24px',
              color: 'var(--peek-fg-dim)',
              fontSize: 'var(--peek-fs-xs)',
              letterSpacing: '0.04em',
              borderBottom: '1px solid var(--peek-border)',
            }}
          >
            <b style={{ color: 'var(--peek-fg)', fontWeight: 500 }}>
              {sorted.length} recording{sorted.length === 1 ? '' : 's'}
            </b>
            {openCount > 0 && (
              <>
                {' · '}
                <span style={{ color: 'var(--peek-accent)' }}>{openCount} live</span>
              </>
            )}
            {' · '}
            {totalTokens.toLocaleString('en-US')} tokens
          </div>

          {/* ── error ── */}
          {error !== null && (
            <div
              data-testid="recordings-error"
              style={{
                padding: 24,
                color: 'var(--peek-bad)',
                fontSize: 'var(--peek-fs-sm)',
              }}
            >
              {error}
            </div>
          )}

          {/* ── empty ── */}
          {error === null && sorted.length === 0 && (
            <div
              data-testid="recordings-empty"
              style={{
                padding: '72px 24px',
                textAlign: 'center',
                color: 'var(--peek-fg-faint)',
                fontSize: 'var(--peek-fs-sm)',
                lineHeight: 1.6,
                letterSpacing: '0.02em',
              }}
            >
              {loading ? (
                <span>loading recordings…</span>
              ) : (
                <>
                  <div style={{ color: 'var(--peek-fg-dim)', fontSize: 'var(--peek-fs-md)' }}>
                    no recordings yet
                  </div>
                  <div style={{ maxWidth: 520, margin: '10px auto 0' }}>
                    in Claude Code, type{' '}
                    <code
                      style={{
                        background: 'var(--peek-surface-2)',
                        border: '1px solid var(--peek-border)',
                        color: 'var(--peek-fg)',
                        padding: '1px 6px',
                        fontSize: 'var(--peek-fs-xs)',
                      }}
                    >
                      /peek_start NAME
                    </code>{' '}
                    to start a recording.
                    <br />
                    close it with{' '}
                    <code
                      style={{
                        background: 'var(--peek-surface-2)',
                        border: '1px solid var(--peek-border)',
                        color: 'var(--peek-fg)',
                        padding: '1px 6px',
                        fontSize: 'var(--peek-fs-xs)',
                      }}
                    >
                      /peek_end
                    </code>
                    .
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── table ── */}
          {sorted.length > 0 && (
            <div data-testid="recordings-table">
              <HeaderRow />
              {sorted.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </div>
          )}

          {/* ── footer ── */}
          <div
            style={{
              padding: '12px 24px',
              borderTop: '1px solid var(--peek-border)',
              color: 'var(--peek-fg-faint)',
              fontSize: 10,
              letterSpacing: '0.12em',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>↑↓ navigate · ⏎ open</span>
            <span>peek 0.3 · local</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const COLUMNS = 'minmax(240px, 2fr) 130px 110px 80px 70px 110px 110px';

function HeaderRow(): ReactElement {
  const cell = {
    padding: '10px 14px',
    color: 'var(--peek-fg-faint)',
    fontSize: 10,
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
  };
  return (
    <div
      data-testid="recordings-header"
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        borderBottom: '1px solid var(--peek-border)',
        background: 'var(--peek-surface-2)',
      }}
    >
      <div style={cell}>name</div>
      <div style={cell}>started</div>
      <div style={cell}>duration</div>
      <div style={{ ...cell, textAlign: 'right' }}>tools</div>
      <div style={{ ...cell, textAlign: 'right' }}>api</div>
      <div style={{ ...cell, textAlign: 'right' }}>tokens</div>
      <div style={cell}>status</div>
    </div>
  );
}

function Row({ r }: { r: RecordingSummary }): ReactElement {
  const isLive = r.status === 'recording';
  const cell: React.CSSProperties = {
    padding: '14px',
    fontSize: 'var(--peek-fs-sm)',
    color: 'var(--peek-fg-dim)',
    fontVariantNumeric: 'tabular-nums',
    alignSelf: 'center',
  };
  const numCell: React.CSSProperties = { ...cell, textAlign: 'right' };

  return (
    <Link
      to={`/recording/${encodeURIComponent(r.id)}`}
      data-testid={`recording-row-${r.id}`}
      data-recording-id={r.id}
      aria-label={`open recording ${r.name}`}
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        alignItems: 'stretch',
        borderBottom: '1px solid var(--peek-border)',
        borderLeft: '2px solid transparent',
        textDecoration: 'none',
        color: 'inherit',
        background: 'transparent',
      }}
      onMouseEnter={(e): void => {
        e.currentTarget.style.background = 'var(--peek-surface-2)';
        e.currentTarget.style.borderLeftColor = isLive
          ? 'var(--peek-accent)'
          : 'var(--peek-border)';
      }}
      onMouseLeave={(e): void => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.borderLeftColor = 'transparent';
      }}
    >
      <div data-testid={`recording-name-${r.id}`} style={{ ...cell, color: 'var(--peek-fg)' }}>
        <div
          style={{
            fontWeight: 500,
            fontSize: 'var(--peek-fs-md)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {r.name}
        </div>
        <div
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            marginTop: 3,
            letterSpacing: '0.04em',
          }}
        >
          {r.sessionId.slice(0, 8)}
        </div>
      </div>
      <div style={cell}>{formatStarted(r.startTs)}</div>
      <div data-testid="recording-duration" style={cell}>
        {isLive ? (
          <span style={{ color: 'var(--peek-accent)' }}>ongoing</span>
        ) : (
          formatDuration(r.durationMs)
        )}
      </div>
      <div data-testid="recording-tools" style={numCell}>
        {r.toolCount.toLocaleString('en-US')}
      </div>
      <div data-testid="recording-api" style={numCell}>
        {r.apiCount.toLocaleString('en-US')}
      </div>
      <div data-testid="recording-tokens" style={numCell}>
        {r.totalTokens.toLocaleString('en-US')}
      </div>
      <div style={cell}>
        {isLive ? (
          <span
            data-testid={`recording-live-badge-${r.id}`}
            aria-label="live"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: '#d9993a',
              padding: '1px 6px',
              border: '1px solid rgba(217, 153, 58, 0.35)',
            }}
          >
            <span aria-hidden="true" className="peek-live-dot" />
            recording
          </span>
        ) : (
          <span
            data-testid={`recording-status-${r.id}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'lowercase',
              color: 'var(--peek-fg-faint)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--peek-fg-faint)',
              }}
            />
            {r.status === 'closed' ? 'closed' : 'auto-closed'}
          </span>
        )}
      </div>
    </Link>
  );
}
