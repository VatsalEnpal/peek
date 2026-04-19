import type { ReactElement } from 'react';
/**
 * Level-1 landing page — the sessions list.
 *
 * Targets `/tmp/peek-mockup.html` L1 exactly: PEEK brand + tagline, search
 * input, Import button, keyboard hint, meta line, date-grouped sessions with
 * slug-first rows, clickable links into `/session/:id`.
 *
 * L2.3: ImportDialog is a full wizard with checkbox selection + progress.
 * L2.4: The search input filters sessions locally by prompt text, slug, and
 *   git branch (case-insensitive substring match). Empty query → all rows.
 * L2.5: Each session row has a chevron that lazily fetches and renders its
 *   bookmarks as a nested sub-list. Expansion state lives in local component
 *   state so navigation resets it — intentional.
 *
 * Slug policy (MOCKUP invariant):
 *   - Render `session.slug` when non-empty.
 *   - Only fall back to the first 8 hex characters of `session.id` when slug is
 *     missing. Never prefer hex over slug.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ImportDialog } from '../components/ImportDialog';
import { HelpPanel } from '../components/HelpPanel';
import { useSessionStore, type SessionSummary } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { useBookmarksStore } from '../stores/bookmarks';
import { useLiveSessionsList } from '../lib/useLiveSessionsList';
import { truncate } from '../lib/format';
import type { BookmarkDto } from '../lib/api';

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

function groupSessions(
  sessions: SessionSummary[],
  isLive: (id: string) => boolean = (): boolean => false
): GroupedSessions {
  const out: GroupedSessions = { active: [], today: [], yesterday: [], earlier: [] };
  for (const s of sessions) {
    // L2.3 — live sessions always surface in the `active` bucket so a
    // newly-started session appears at the top of the list, regardless of
    // its startTs-derived day bucket.
    if (isLive(s.id)) out.active.push(s);
    else out[bucketFor(s)].push(s);
  }
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

/**
 * Case-insensitive substring match across prompt, slug, and branch.
 *
 * Exported so the unit test can exercise the same predicate the page uses.
 */
export function sessionMatches(s: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystacks: string[] = [];
  if (s.firstPrompt) haystacks.push(s.firstPrompt);
  if (s.slug) haystacks.push(s.slug);
  if (s.gitBranch) haystacks.push(s.gitBranch);
  if (s.label) haystacks.push(s.label);
  haystacks.push(s.id); // still searchable by hex id
  for (const h of haystacks) {
    if (h.toLowerCase().includes(q)) return true;
  }
  return false;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleHelp = useSelectionStore((s) => s.toggleHelp);

  // L2.3 — live-session activity tracking + LIVE-badge gating for the watch
  // hint. The hook owns its own SSE subscription; the Sessions page only
  // reads the two predicates.
  const { isLive, hasAnyLive } = useLiveSessionsList();

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const filtered = useMemo(
    () => sessions.filter((s) => sessionMatches(s, search)),
    [sessions, search]
  );

  const grouped = useMemo(() => groupSessions(filtered, isLive), [filtered, isLive]);
  const totalSpans = useMemo(
    () => sessions.reduce((n, s) => n + (s.turnCount ?? 0), 0),
    [sessions]
  );
  const totalTokens = useMemo(
    () => sessions.reduce((n, s) => n + (s.totalTokens ?? 0), 0),
    [sessions]
  );

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasQuery = search.trim().length > 0;
  const hasNoMatches =
    sessions.length > 0 && filtered.length === 0 && hasQuery && sessionsError === null;

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
            <button
              type="button"
              data-testid="help-btn"
              onClick={toggleHelp}
              aria-label="show help"
              className="peek-mono"
              style={{
                fontSize: 10,
                color: 'var(--peek-fg-faint)',
                border: '1px solid var(--peek-border)',
                background: 'transparent',
                padding: '1px 5px',
                cursor: 'pointer',
              }}
            >
              ?
            </button>
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
            <b style={{ color: 'var(--peek-fg)', fontWeight: 500 }}>
              {hasQuery
                ? `${filtered.length} / ${sessions.length} sessions`
                : `${sessions.length} sessions`}
            </b>
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
                padding: '64px 24px',
                color: 'var(--peek-fg-faint)',
                fontSize: 'var(--peek-fs-sm)',
                textAlign: 'center',
                letterSpacing: '0.02em',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
              }}
            >
              {sessionsLoading ? (
                <span>loading sessions…</span>
              ) : (
                <>
                  <div style={{ color: 'var(--peek-fg-dim)', fontSize: 'var(--peek-fs-md)' }}>
                    No sessions yet.
                  </div>
                  <div style={{ maxWidth: 560, lineHeight: 1.55 }}>
                    Run{' '}
                    <code
                      className="peek-mono"
                      style={{
                        background: 'var(--peek-surface-2)',
                        border: '1px solid var(--peek-border)',
                        padding: '1px 6px',
                        color: 'var(--peek-fg)',
                        fontSize: 'var(--peek-fs-xs)',
                      }}
                    >
                      peek watch
                    </code>{' '}
                    to capture live, or{' '}
                    <code
                      className="peek-mono"
                      style={{
                        background: 'var(--peek-surface-2)',
                        border: '1px solid var(--peek-border)',
                        padding: '1px 6px',
                        color: 'var(--peek-fg)',
                        fontSize: 'var(--peek-fs-xs)',
                      }}
                    >
                      peek import &lt;path&gt;
                    </code>{' '}
                    for existing sessions.
                  </div>
                </>
              )}
            </div>
          )}

          {sessionsError === null && sessions.length > 0 && !hasAnyLive() && (
            // L2.3 gate — when at least one session is live, the LIVE badge
            // already tells the user the watcher is active; this static hint
            // would just be duplicate chrome, so suppress it.
            <div
              data-testid="sessions-watch-hint"
              className="peek-mono"
              style={{
                padding: '10px 24px 2px',
                color: 'var(--peek-fg-faint)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'lowercase',
              }}
            >
              watching{' '}
              <code
                style={{
                  color: 'var(--peek-fg-dim)',
                  background: 'transparent',
                  fontSize: 10,
                  letterSpacing: '0.04em',
                }}
              >
                ~/.claude/projects/
              </code>{' '}
              — new sessions appear here live
            </div>
          )}

          {hasNoMatches && (
            <div
              data-testid="sessions-no-matches"
              style={{
                padding: '48px 24px',
                color: 'var(--peek-fg-faint)',
                fontSize: 'var(--peek-fs-sm)',
                textAlign: 'center',
                letterSpacing: '0.04em',
              }}
            >
              no matches for &ldquo;{search.trim()}&rdquo;
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
                  <SessionRow
                    key={s.id}
                    session={s}
                    expanded={expanded.has(s.id)}
                    live={isLive(s.id)}
                    onToggle={(): void => toggleExpand(s.id)}
                  />
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
      <HelpPanel />
    </div>
  );
}

/** Single session row — entire card is a clickable Link to /session/:id. */
function SessionRow({
  session: s,
  expanded,
  live,
  onToggle,
}: {
  session: SessionSummary;
  expanded: boolean;
  live: boolean;
  onToggle: () => void;
}): ReactElement {
  const ratio = Math.min(1, Math.max(0, s.totalTokens / CONTEXT_CEILING));
  const barPct = `${Math.round(ratio * 100)}%`;

  return (
    <>
      <div
        data-testid={`session-wrap-${s.id}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 1fr',
          alignItems: 'stretch',
        }}
      >
        {/* Chevron column — a real button so keyboard users can toggle without
            triggering the enclosing Link's navigation. */}
        <button
          type="button"
          data-testid={`session-expand-${s.id}`}
          aria-label={
            expanded
              ? `collapse bookmarks for ${displaySlug(s)}`
              : `expand bookmarks for ${displaySlug(s)}`
          }
          aria-expanded={expanded}
          onClick={(e): void => {
            e.stopPropagation();
            e.preventDefault();
            onToggle();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: expanded ? 'var(--peek-accent)' : 'var(--peek-fg-faint)',
            fontSize: 10,
            cursor: 'pointer',
            padding: 0,
            width: 20,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 120ms ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transformOrigin: 'center',
          }}
        >
          ▸
        </button>

        <Link
          to={`/session/${encodeURIComponent(s.id)}`}
          data-testid={`session-row-${s.id}`}
          data-session-id={s.id}
          aria-label={`open session ${displaySlug(s)}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '8px 24px',
            padding: '14px 24px 14px 4px',
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
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {displaySlug(s)}
            {live && (
              <span
                data-testid={`session-live-badge-${s.id}`}
                aria-label="live"
                className="peek-mono"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: '#d9993a',
                  padding: '1px 6px 1px 5px',
                  border: '1px solid rgba(217, 153, 58, 0.35)',
                }}
              >
                <span aria-hidden="true" className="peek-live-dot" />
                live
              </span>
            )}
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
      </div>

      {expanded && <BookmarkList sessionId={s.id} />}
    </>
  );
}

/**
 * Lazily-fetched bookmark list rendered under an expanded session row.
 *
 * Uses `useBookmarksStore` so multiple expansions of the same session don't
 * refetch, and so a future bookmark-create action can invalidate the cache
 * cleanly.
 */
function BookmarkList({ sessionId }: { sessionId: string }): ReactElement {
  const bms = useBookmarksStore((s) => s.bySession[sessionId]);
  const loading = useBookmarksStore((s) => s.loading);
  const error = useBookmarksStore((s) => s.error);
  const fetchForSession = useBookmarksStore((s) => s.fetchForSession);

  useEffect(() => {
    void fetchForSession(sessionId);
  }, [sessionId, fetchForSession]);

  if (bms === undefined) {
    return (
      <div
        data-testid={`bookmarks-loading-${sessionId}`}
        style={{
          padding: '6px 24px 6px 48px',
          color: 'var(--peek-fg-faint)',
          fontSize: 'var(--peek-fs-xs)',
          fontFamily: 'var(--peek-font-mono)',
        }}
      >
        {loading ? 'loading bookmarks…' : error !== null ? `error: ${error}` : 'loading…'}
      </div>
    );
  }

  if (bms.length === 0) {
    return (
      <div
        data-testid={`bookmarks-empty-${sessionId}`}
        style={{
          padding: '6px 24px 6px 48px',
          color: 'var(--peek-fg-faint)',
          fontSize: 'var(--peek-fs-xs)',
          fontStyle: 'italic',
          fontFamily: 'var(--peek-font-mono)',
        }}
      >
        (no bookmarks)
      </div>
    );
  }

  return (
    <div data-testid={`bookmarks-list-${sessionId}`}>
      {bms.map((b) => (
        <BookmarkRow key={b.id} sessionId={sessionId} bookmark={b} />
      ))}
    </div>
  );
}

function BookmarkRow({
  sessionId,
  bookmark: b,
}: {
  sessionId: string;
  bookmark: BookmarkDto;
}): ReactElement {
  // Bookmarks carry startTs/endTs but not always a spanId. If the bookmark
  // metadata contains an anchor spanId (future-proofing), deep-link to the
  // Inspector; otherwise fall back to the session detail page.
  const anchorSpanId = readAnchorSpanId(b);
  const href =
    anchorSpanId !== null
      ? `/session/${encodeURIComponent(sessionId)}/span/${encodeURIComponent(anchorSpanId)}`
      : `/session/${encodeURIComponent(sessionId)}`;
  const source = (b.source ?? 'bookmark').toUpperCase();
  const label = b.label ?? '(unnamed)';
  const ts = b.startTs ?? '';

  return (
    <Link
      to={href}
      data-testid={`bookmark-row-${b.id}`}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
        padding: '6px 24px 6px 48px',
        color: 'var(--peek-fg-dim)',
        fontSize: 'var(--peek-fs-xs)',
        fontFamily: 'var(--peek-font-mono)',
        textDecoration: 'none',
        borderLeft: '2px solid var(--peek-border)',
        marginLeft: 20,
        background: 'transparent',
      }}
      onMouseEnter={(e): void => {
        e.currentTarget.style.background = 'var(--peek-surface-2)';
        e.currentTarget.style.borderLeftColor = 'var(--peek-accent)';
      }}
      onMouseLeave={(e): void => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.borderLeftColor = 'var(--peek-border)';
      }}
    >
      <span
        style={{
          color: 'var(--peek-fg-faint)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          minWidth: 64,
        }}
      >
        {source}
      </span>
      <span
        style={{
          color: 'var(--peek-fg)',
          fontWeight: 500,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {ts.length > 0 && (
        <span
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {ts}
        </span>
      )}
    </Link>
  );
}

/** Read an anchor spanId from a bookmark's metadata, if present. */
function readAnchorSpanId(b: BookmarkDto): string | null {
  const m = b.metadata;
  if (!m || typeof m !== 'object') return null;
  const candidate =
    (m as Record<string, unknown>)['anchorSpanId'] ?? (m as Record<string, unknown>)['spanId'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
