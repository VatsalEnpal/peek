import type { ReactElement } from 'react';
/**
 * Level-1 landing page — the sessions list.
 *
 * Targets `/tmp/peek-mockup.html` L1 exactly: PEEK brand + tagline, search
 * input, Import button, keyboard hint, meta line, date-grouped sessions with
 * slug-first rows, clickable links into `/session/:id`.
 *
 * Scope of this tick (L2.2):
 *   - The search input is **present and controlled** but its filter logic is
 *     deferred to L2.4. We still bind `value`/`onChange` so keyboard users can
 *     type without losing characters.
 *   - Bookmark nesting within session cards is deferred to L2.5.
 *   - ImportWizard polish is deferred to L2.3 — we reuse the existing
 *     `ImportDialog` so the button is real, not a stub.
 *
 * Slug policy (MOCKUP invariant):
 *   - Render `session.slug` when non-empty.
 *   - Only fall back to the first 8 hex characters of `session.id` when slug is
 *     missing. Never prefer hex over slug.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ImportDialog } from '../components/ImportDialog';
import { useSessionStore, type SessionSummary } from '../stores/session';
import { truncate } from '../lib/format';

type DateBucket = 'active' | 'today' | 'yesterday' | 'earlier';

type GroupedSessions = Record<DateBucket, SessionSummary[]>;

const BUCKET_ORDER: DateBucket[] = ['active', 'today', 'yesterday', 'earlier'];

const BUCKET_LABEL: Record<DateBucket, string> = {
  active: 'active',
  today: 'today',
  yesterday: 'yesterday',
  earlier: 'earlier',
};

/** Day-granularity bucket — no active/recording detection yet (defer). */
function bucketFor(s: SessionSummary, now: Date = new Date()): DateBucket {
  const ts = s.startTs ?? s.endTs;
  if (!ts) return 'earlier';
  const then = new Date(ts);
  if (Number.isNaN(then.getTime())) return 'earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const t = then.getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfYesterday) return 'yesterday';
  return 'earlier';
}

function groupSessions(sessions: SessionSummary[]): GroupedSessions {
  const out: GroupedSessions = { active: [], today: [], yesterday: [], earlier: [] };
  for (const s of sessions) out[bucketFor(s)].push(s);
  return out;
}

/** Slug-first label per mockup. Fallback ONLY when slug is missing. */
export function displaySlug(s: SessionSummary): string {
  if (s.slug && s.slug.length > 0) return s.slug;
  return s.id.slice(0, 8);
}

/** Pull a one-line prompt preview, stripping surrounding quotes/newlines. */
function promptPreview(s: SessionSummary): string {
  const raw = (s.firstPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '(no prompt)';
  return truncate(raw, 96);
}

/** Formatter for the context bar ratio. Hard-coded 200k ceiling for v0.2. */
const CONTEXT_CEILING = 200_000;

export function SessionsPage(): ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoading = useSessionStore((s) => s.sessionsLoading);
  const sessionsError = useSessionStore((s) => s.sessionsError);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);

  const [search, setSearch] = useState<string>('');
  const [importOpen, setImportOpen] = useState<boolean>(false);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const grouped = useMemo(() => groupSessions(sessions), [sessions]);
  const totalSpans = useMemo(
    () => sessions.reduce((n, s) => n + (s.turnCount ?? 0), 0),
    [sessions]
  );
  const totalTokens = useMemo(
    () => sessions.reduce((n, s) => n + (s.totalTokens ?? 0), 0),
    [sessions]
  );

  return (
    <div
      data-testid="sessions-page"
      style={{
        minHeight: '100vh',
        background: 'var(--peek-bg)',
        color: 'var(--peek-fg)',
        fontFamily: 'var(--peek-font-mono)',
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '40px',
        }}
      >
        <div
          data-testid="sessions-frame"
          style={{
            border: '1px solid var(--peek-border)',
            background: 'var(--peek-surface)',
          }}
        >
          {/* ── topbar ── */}
          <header
            data-testid="sessions-topbar"
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
              see what your agents actually loaded
            </span>
            <span style={{ flex: 1 }} />
            <label
              aria-label="search sessions"
              style={{ display: 'inline-flex', alignItems: 'baseline' }}
            >
              <input
                type="text"
                data-testid="sessions-search"
                aria-label="search sessions, prompts, branches"
                placeholder="search sessions, prompts, branches…"
                value={search}
                onChange={(e): void => setSearch(e.target.value)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--peek-border)',
                  color: 'var(--peek-fg)',
                  padding: '4px 10px',
                  fontFamily: 'var(--peek-font-mono)',
                  fontSize: 'var(--peek-fs-sm)',
                  width: 280,
                  outline: 'none',
                }}
              />
            </label>
            <button
              type="button"
              data-testid="import-btn"
              onClick={(): void => setImportOpen(true)}
              aria-label="import sessions"
              style={{
                background: 'transparent',
                color: 'var(--peek-fg)',
                border: '1px solid var(--peek-border)',
                padding: '4px 10px',
                fontFamily: 'var(--peek-font-mono)',
                fontSize: 'var(--peek-fs-xs)',
                letterSpacing: '0.06em',
                cursor: 'pointer',
                textTransform: 'lowercase',
              }}
            >
              import
            </button>
            <span
              aria-hidden="true"
              style={{
                fontSize: 10,
                color: 'var(--peek-fg-faint)',
                border: '1px solid var(--peek-border)',
                padding: '1px 5px',
              }}
            >
              ?
            </span>
          </header>

          {/* ── meta line ── */}
          <div
            data-testid="sessions-meta"
            style={{
              padding: '12px 24px',
              color: 'var(--peek-fg-dim)',
              fontSize: 'var(--peek-fs-xs)',
              letterSpacing: '0.04em',
              borderBottom: '1px solid var(--peek-border)',
            }}
          >
            <b style={{ color: 'var(--peek-fg)', fontWeight: 500 }}>{sessions.length} sessions</b>
            {' · '}
            {totalSpans.toLocaleString('en-US')} turns
            {' · '}
            {totalTokens.toLocaleString('en-US')} tokens
          </div>

          {/* ── error / loading / empty ── */}
          {sessionsError !== null && (
            <div
              data-testid="sessions-error"
              style={{
                padding: '24px',
                color: 'var(--peek-bad)',
                fontSize: 'var(--peek-fs-sm)',
              }}
            >
              {sessionsError}
            </div>
          )}

          {sessionsError === null && sessions.length === 0 && (
            <div
              data-testid="sessions-empty"
              style={{
                padding: '48px 24px',
                color: 'var(--peek-fg-faint)',
                fontSize: 'var(--peek-fs-sm)',
                textAlign: 'center',
              }}
            >
              {sessionsLoading
                ? 'loading sessions…'
                : 'no sessions yet — click import to scan ~/.claude/projects'}
            </div>
          )}

          {/* ── grouped session rows ── */}
          {BUCKET_ORDER.map((bucket) => {
            const rows = grouped[bucket];
            if (rows.length === 0) return null;
            return (
              <div key={bucket} data-testid={`sessions-group-${bucket}`}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '22px 24px 8px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--peek-fg-faint)',
                    fontSize: 10,
                  }}
                >
                  <span>{BUCKET_LABEL[bucket]}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: 1,
                      height: 1,
                      background: 'var(--peek-border)',
                    }}
                  />
                </div>
                {rows.map((s) => (
                  <SessionRow key={s.id} session={s} />
                ))}
              </div>
            );
          })}

          {/* ── footer keyboard hint ── */}
          <div
            style={{
              padding: '12px 24px',
              borderTop: '1px solid var(--peek-border)',
              color: 'var(--peek-fg-faint)',
              fontSize: 10,
              letterSpacing: '0.12em',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <span>↑↓ navigate · ⏎ open · / search</span>
            <span>peek 0.2 · local</span>
          </div>
        </div>
      </div>

      <ImportDialog open={importOpen} onClose={(): void => setImportOpen(false)} />
    </div>
  );
}

/** Single session row — entire card is a clickable Link to /session/:id. */
function SessionRow({ session: s }: { session: SessionSummary }): ReactElement {
  const ratio = Math.min(1, Math.max(0, s.totalTokens / CONTEXT_CEILING));
  const barPct = `${Math.round(ratio * 100)}%`;

  return (
    <Link
      to={`/session/${encodeURIComponent(s.id)}`}
      data-testid={`session-row-${s.id}`}
      data-session-id={s.id}
      aria-label={`open session ${displaySlug(s)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '8px 24px',
        padding: '14px 24px',
        borderBottom: '1px solid transparent',
        borderLeft: '2px solid transparent',
        cursor: 'pointer',
        textDecoration: 'none',
        color: 'inherit',
      }}
      onMouseEnter={(e): void => {
        e.currentTarget.style.background = 'var(--peek-surface-2)';
        e.currentTarget.style.borderLeftColor = 'var(--peek-accent)';
      }}
      onMouseLeave={(e): void => {
        e.currentTarget.style.background = '';
        e.currentTarget.style.borderLeftColor = 'transparent';
      }}
    >
      <div
        data-testid="session-slug"
        style={{
          color: 'var(--peek-fg)',
          fontWeight: 500,
          fontFamily: 'var(--peek-font-mono)',
          fontSize: 'var(--peek-fs-md)',
        }}
      >
        {displaySlug(s)}
      </div>

      <div
        data-testid="session-time"
        style={{
          gridColumn: 2,
          gridRow: 1,
          color: 'var(--peek-fg-faint)',
          fontSize: 'var(--peek-fs-xs)',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--peek-font-mono)',
        }}
      >
        {s.timeAgo}
      </div>

      <div
        style={{
          gridColumn: 1,
          fontFamily: '"Fraunces", Georgia, serif',
          fontSize: 'var(--peek-fs-lg)',
          fontStyle: 'italic',
          color: 'var(--peek-fg-dim)',
          letterSpacing: '-0.005em',
        }}
      >
        &ldquo;{promptPreview(s)}&rdquo;
      </div>

      <div
        data-testid="session-meta"
        style={{
          gridColumn: 1,
          color: 'var(--peek-fg-faint)',
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.03em',
          fontFamily: 'var(--peek-font-mono)',
        }}
      >
        <span>{s.gitBranch ?? 'no-branch'}</span>
        <span style={{ color: 'var(--peek-border)' }}> · </span>
        <span>{s.turnCount.toLocaleString('en-US')} turns</span>
      </div>

      <div
        style={{
          gridColumn: 2,
          gridRow: '2 / span 2',
          alignSelf: 'end',
          fontSize: 'var(--peek-fs-xs)',
          color: 'var(--peek-fg-faint)',
          textAlign: 'right',
          fontFamily: 'var(--peek-font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 100,
            height: 3,
            background: 'var(--peek-border)',
            marginRight: 8,
            verticalAlign: 'middle',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: barPct,
              background: 'var(--peek-accent)',
            }}
          />
        </span>
        <span>
          {s.totalTokens.toLocaleString('en-US')} / {CONTEXT_CEILING.toLocaleString('en-US')}
        </span>
      </div>
    </Link>
  );
}
