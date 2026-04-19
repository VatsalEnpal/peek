import type { ReactElement } from 'react';
/**
 * Level-2 route — session detail + timeline.
 *
 * Layout matches `/tmp/peek-mockup.html` L2:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ PEEK · session detail                               [?] │  ← topbar
 *   ├─────────────────────────────────────────────────────────┤
 *   │ ← sessions   "first user prompt…"          [● record]    │  ← l2 header
 *   │ sessionId · branch · timeAgo · turns · tokens            │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ CONTEXT  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬   159,806 / 200,000         │  ← gauge
 *   ├─────────────────────────────────────────────────────────┤
 *   │ [prompts 47] [files 182] [skills …] …                    │  ← chips
 *   ├─────────────────────────────────────────────────────────┤
 *   │ 14:03:21  📝  PROMPT   "fix the PTY bug…"     23  ▸     │  ← timeline
 *   │ 14:03:22  🌐  API      claude-opus-4-7        412       │
 *   │ …                                                        │
 *   └─────────────────────────────────────────────────────────┘
 *   (Inspector drawer slides in from right when a row is clicked.)
 *
 * Keeps the legacy `data-testid="app-shell"` + `data-testid="topbar"` hooks
 * used by integration tests — the test environment still renders `<App/>` and
 * navigates to `/session/:id`, landing here.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Timeline } from '../components/Timeline';
import { Inspector } from '../components/Inspector';
import { FilterChips } from '../components/FilterChips';
import { RecordButton } from '../components/RecordButton';
import { ContextGauge } from '../components/ContextGauge';
import { computeContextGaugeStats } from '../lib/contextGauge';
import { FocusBar } from '../components/FocusBar';
import { KbHelp } from '../components/KbHelp';
import { ImportDialog } from '../components/ImportDialog';
import { useSessionStore, buildTimelineRows } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { useRecordingStore } from '../stores/recording';
import { bindKeyboard, type KbAction } from '../lib/keyboard';
import { truncate } from '../lib/format';

/** Slug-first label per mockup. Fallback ONLY when slug is missing. */
function displayTitle(slug: string | null | undefined, id: string): string {
  if (slug && slug.length > 0) return slug;
  return id.slice(0, 8);
}

export function SessionDetailPage(): ReactElement {
  const { id, spanId } = useParams<{ id: string; spanId?: string }>();
  const navigate = useNavigate();

  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const selectSession = useSessionStore((s) => s.selectSession);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const events = useSessionStore((s) => s.events);
  const expandSpan = useSessionStore((s) => s.expandSpan);
  const collapseSpan = useSessionStore((s) => s.collapseSpan);

  const selectSpan = useSelectionStore((s) => s.selectSpan);
  const closeDrawer = useSelectionStore((s) => s.closeDrawer);
  const toggleHelp = useSelectionStore((s) => s.toggleHelp);
  const setHelp = useSelectionStore((s) => s.setHelp);

  const [importOpen, setImportOpen] = useState<boolean>(false);

  // Top-up fetch: if user lands here directly (deep-link) we won't have the
  // sessions list yet.
  useEffect(() => {
    if (sessions.length === 0) void fetchSessions();
  }, [sessions.length, fetchSessions]);

  // URL → store. One-way sync for :id.
  useEffect(() => {
    if (!id) return;
    if (id !== selectedSessionId) void selectSession(id);
  }, [id, selectedSessionId, selectSession]);

  // URL → store for :spanId (drawer open).
  useEffect(() => {
    if (spanId) selectSpan(spanId);
    else closeDrawer();
  }, [spanId, selectSpan, closeDrawer]);

  // Global keyboard bindings. Identical to the legacy AppShell bindings so
  // keyboard-first users get the same j/k/h/l/enter/esc/?/⌘⇧R behaviour.
  useEffect(() => {
    const getRows = (): Array<{ id: string; hasChildren: boolean }> =>
      buildTimelineRows(
        useSessionStore.getState().events,
        useSessionStore.getState().activeChips,
        useSessionStore.getState().expandedSpans
      );
    const currentIndex = (rows: Array<{ id: string }>): number => {
      const sel = useSelectionStore.getState().selectedSpanId;
      if (!sel) return -1;
      return rows.findIndex((r) => r.id === sel);
    };
    const handler = (a: KbAction): void => {
      const rows = getRows();
      if (
        rows.length === 0 &&
        a.kind !== 'toggle-help' &&
        a.kind !== 'close' &&
        a.kind !== 'toggle-record'
      ) {
        return;
      }
      switch (a.kind) {
        case 'next': {
          const i = currentIndex(rows);
          const next = rows[Math.min(rows.length - 1, Math.max(0, i + 1))];
          if (next) selectSpan(next.id);
          break;
        }
        case 'prev': {
          const i = currentIndex(rows);
          const prev = rows[Math.max(0, i - 1)];
          if (prev) selectSpan(prev.id);
          break;
        }
        case 'expand': {
          const i = currentIndex(rows);
          const row = rows[i];
          if (row?.hasChildren) expandSpan(row.id);
          break;
        }
        case 'collapse': {
          const i = currentIndex(rows);
          const row = rows[i];
          if (row) collapseSpan(row.id);
          break;
        }
        case 'open': {
          const i = currentIndex(rows);
          const row = rows[i] ?? rows[0];
          if (row) selectSpan(row.id);
          break;
        }
        case 'close': {
          if (useSelectionStore.getState().helpOpen) {
            setHelp(false);
          } else {
            // L4.1 — Esc reverts URL from /session/:id/span/:spanId →
            // /session/:id. The URL→store effect above will then fire
            // `closeDrawer()` so the two remain in lockstep; calling
            // `closeDrawer()` here too would double-close and race the
            // transition animation.
            const sessId = useSessionStore.getState().selectedSessionId;
            if (useSelectionStore.getState().drawerOpen && sessId) {
              navigate(`/session/${encodeURIComponent(sessId)}`, { replace: false });
            } else {
              closeDrawer();
            }
          }
          break;
        }
        case 'toggle-help':
          toggleHelp();
          break;
        case 'toggle-record': {
          const rec = useRecordingStore.getState();
          const sessionId = useSessionStore.getState().selectedSessionId;
          if (rec.isRecording) {
            void rec.stopRecording();
          } else if (sessionId) {
            const lastPrompt = lastUserPrompt(useSessionStore.getState().events);
            const raw =
              typeof window !== 'undefined' && typeof window.prompt === 'function'
                ? window.prompt('Label this recording:', lastPrompt)
                : '';
            void rec.startRecording(sessionId, (raw ?? '').trim());
          }
          break;
        }
      }
    };
    return bindKeyboard(handler);
  }, [selectSpan, expandSpan, collapseSpan, closeDrawer, toggleHelp, setHelp, navigate]);

  // Currently-viewed session summary (for title/metadata).
  const summary = useMemo(() => sessions.find((s) => s.id === id) ?? null, [sessions, id]);

  // L2.4 — gauge stats: max-per-turn (compared against 200k), cumulative, and
  // turn count for the secondary line. Cumulative is NOT what drives the bar;
  // it's the faint provenance stat users can glance at.
  const gaugeStats = useMemo(() => computeContextGaugeStats(events), [events]);

  const spanCount = useMemo(() => events.filter((e) => e.kind === 'span').length, [events]);

  const titleRaw = summary?.firstPrompt ?? displayTitle(summary?.slug, id ?? '');
  const titleDisplay = truncate(titleRaw.replace(/\s+/g, ' ').trim(), 96);

  return (
    <div
      data-testid="app-shell"
      data-mockup-level="l2"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--peek-bg)',
        color: 'var(--peek-fg)',
      }}
    >
      {/* ── topbar: PEEK · tagline · ? ── */}
      <header
        data-testid="topbar"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 24,
          padding: '18px 24px 14px',
          borderBottom: '1px solid var(--peek-border)',
          background: 'var(--peek-surface)',
          flexShrink: 0,
        }}
      >
        <span
          data-testid="peek-brand"
          className="peek-mono"
          style={{
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--peek-accent)',
            fontSize: 'var(--peek-fs-md)',
          }}
        >
          peek
        </span>
        <span
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.04em',
          }}
        >
          session detail
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="import-btn"
          onClick={(): void => setImportOpen(true)}
          aria-label="import sessions"
          className="peek-mono"
          style={{
            padding: '4px 10px',
            background: 'transparent',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-dim)',
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          import
        </button>
        <button
          type="button"
          onClick={toggleHelp}
          className="peek-mono"
          aria-label="show keyboard shortcuts"
          style={{
            fontSize: 10,
            padding: '1px 5px',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-faint)',
          }}
        >
          ?
        </button>
      </header>

      {/* ── L2 header: back · title · record + sub-line ── */}
      <div
        data-testid="l2-header"
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: '12px 24px',
          padding: '18px 24px 14px',
          alignItems: 'baseline',
          borderBottom: '1px solid var(--peek-border)',
          background: 'var(--peek-surface)',
        }}
      >
        <Link
          to="/"
          data-testid="back-link"
          onClick={(e): void => {
            // intercept if user wants a proper history-back, else fall through
            if (!e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              navigate(-1);
            }
          }}
          className="peek-mono"
          style={{
            color: 'var(--peek-fg-faint)',
            textDecoration: 'none',
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
          onMouseEnter={(e): void => {
            e.currentTarget.style.color = 'var(--peek-accent)';
          }}
          onMouseLeave={(e): void => {
            e.currentTarget.style.color = 'var(--peek-fg-faint)';
          }}
        >
          ← sessions
        </Link>

        <div
          data-testid="session-title"
          style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontStyle: 'italic',
            fontSize: 'var(--peek-fs-xl)',
            color: 'var(--peek-fg)',
            letterSpacing: '-0.01em',
            fontWeight: 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={titleRaw}
        >
          {summary?.firstPrompt ? `“${titleDisplay}”` : titleDisplay}
        </div>

        <div style={{ gridRow: '1 / span 2', gridColumn: 3, alignSelf: 'center' }}>
          <RecordButton />
        </div>

        <div
          data-testid="session-sub"
          className="peek-mono"
          style={{
            gridColumn: 2,
            color: 'var(--peek-fg-faint)',
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.03em',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0,
          }}
        >
          <SubMetaList
            items={[
              displayTitle(summary?.slug, id ?? ''),
              summary?.gitBranch ?? 'no-branch',
              summary?.timeAgo ?? '',
              summary ? `${summary.turnCount.toLocaleString('en-US')} turns` : '',
              spanCount > 0 ? `${spanCount.toLocaleString('en-US')} spans` : '',
              summary ? `${summary.totalTokens.toLocaleString('en-US')} tokens` : '',
            ]}
          />
        </div>
      </div>

      {/* ── context gauge ── */}
      <ContextGauge
        tokens={gaugeStats.maxPerTurn}
        cumulative={gaugeStats.cumulative}
        turnCount={gaugeStats.turnCount}
        testId="session-context-gauge"
      />

      {/* ── filter chips ── */}
      <div
        data-testid="filters-bar"
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid var(--peek-border)',
          background: 'var(--peek-surface)',
        }}
      >
        <FilterChips />
      </div>

      {/* ── focus bar (conditional) ── */}
      <FocusBar />

      {/* ── main: timeline + inspector ── */}
      <main style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Timeline />
        <Inspector />
      </main>

      <KbHelp />
      <ImportDialog open={importOpen} onClose={(): void => setImportOpen(false)} />
    </div>
  );
}

/**
 * Renders a `·`-separated list, skipping empty segments. Uses spans instead of
 * a flat string so CSS can style the separators independently (faint color).
 */
function SubMetaList({ items }: { items: Array<string | null | undefined> }): ReactElement {
  const clean = items.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return (
    <>
      {clean.map((s, i) => (
        <span key={`${i}-${s}`} style={{ display: 'inline-flex', alignItems: 'baseline' }}>
          {i > 0 && (
            <span aria-hidden="true" style={{ color: 'var(--peek-border)', margin: '0 6px' }}>
              ·
            </span>
          )}
          <span>{s}</span>
        </span>
      ))}
    </>
  );
}

/** Grab the most-recent user_prompt text for the record label default. */
function lastUserPrompt(events: Array<unknown>): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i] as { kind?: string; type?: string; name?: string } | null;
    if (!e) continue;
    if (e.kind === 'span' && e.type === 'user_prompt' && typeof e.name === 'string') {
      return e.name.slice(0, 96);
    }
  }
  return '';
}
