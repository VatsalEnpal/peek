import type { ReactElement, ReactNode } from 'react';
/**
 * Right-side drawer — Level 3 detail per `/tmp/peek-mockup.html` L3.
 *
 * Layout contract (L4.1):
 *   - Fixed 420 px wide, fills viewport vertically, lives in the same flex row
 *     as the Timeline so opening the drawer SHIFTS the timeline left rather
 *     than overlaying it. When closed the <aside> collapses to `width: 0` so
 *     the timeline reclaims the full viewport — no dead 420 px gutter.
 *   - Closes on Esc (handled at SessionDetailPage) or via the header `×`
 *     button. Either path reverts the URL to `/session/:id`, which triggers
 *     the Detail page's URL→store effect and tears down the drawer.
 *   - Deep-link via `/session/:id/span/:spanId` opens the drawer on load
 *     because SessionDetailPage selects that span from `useParams`.
 *
 * Body sections (mockup L3):
 *   TYPE header (uppercase, tracked) · name (serif italic) · metadata line
 *   → parent link → inputs → outputs → context ledger snapshot (L4.2)
 *   → parent/children nav → source link (L4.3).
 */

import { useCallback, useMemo, useState } from 'react';
import { useInRouterContext, useNavigate, type NavigateFunction } from 'react-router-dom';

import { useSessionStore, type SpanEvent, type LedgerEvent } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { formatClock, formatDuration, formatTokens, truncate } from '../lib/format';
import { iconFor } from '../lib/icons';
import { apiPost } from '../lib/api';
import { ContextGauge } from './ContextGauge';
import { UnmaskButton } from './UnmaskButton';

/** Span types whose name renders in serif italic per mockup. */
const SERIF_TYPES = new Set(['subagent', 'api_call', 'user_prompt']);

/**
 * `useNavigate()` throws outside a router context. Return `null` in that
 * case so the Inspector can still render in the BUG-6 regression test which
 * mounts it bare.
 */
function useSafeNavigate(): NavigateFunction | null {
  const inRouter = useInRouterContext();
  // Both branches must invoke the hook the same number of times. We always
  // call `useNavigate` but it's only safe inside the context — gate it.
  if (!inRouter) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useNavigate();
}

export function Inspector(): ReactElement {
  const events = useSessionStore((s) => s.events);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const selectedSpanId = useSelectionStore((s) => s.selectedSpanId);
  const drawerOpen = useSelectionStore((s) => s.drawerOpen);
  const selectSpan = useSelectionStore((s) => s.selectSpan);

  // Some integration tests mount <Inspector /> outside a <BrowserRouter> to
  // exercise Zustand plumbing in isolation. Fall back to the store's
  // closeDrawer/selectSpan when no router is present so the component stays
  // renderable in those harnesses.
  const navigate = useSafeNavigate();
  const closeDrawer = useSelectionStore((s) => s.closeDrawer);

  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const span = useMemo<SpanEvent | null>(() => {
    if (!selectedSpanId) return null;
    for (const e of events) {
      if (e.kind === 'span' && e.id === selectedSpanId) return e;
    }
    return null;
  }, [events, selectedSpanId]);

  /**
   * L4.2 — "live in context" at the moment of this span's startTs:
   *   entry.ts  <= span.startTs     (entries introduced strictly before/at)
   *   + every entry whose introducedBySpanId === span.id  (new-at-this-span)
   *
   * We don't model eviction yet, so there's no upper bound from the other
   * side. If an entry has no `ts` at all (legacy rows) we include it — better
   * to show too much context than silently hide it.
   */
  const ledgerSnapshot = useMemo<LedgerEvent[]>(() => {
    if (!span) return [];
    const cutoff = span.startTs ?? undefined;
    const out: LedgerEvent[] = [];
    for (const e of events) {
      if (e.kind !== 'ledger') continue;
      if (e.introducedBySpanId === span.id) {
        out.push(e);
        continue;
      }
      if (!cutoff) continue; // can't compare → skip to avoid "future" leaks
      if (!e.ts) {
        out.push(e);
        continue;
      }
      if (e.ts <= cutoff) out.push(e);
    }
    // Stable sort: ts asc (missing ts sinks to bottom).
    out.sort((a, b) => {
      const aT = a.ts ?? '\uffff';
      const bT = b.ts ?? '\uffff';
      return aT < bT ? -1 : aT > bT ? 1 : 0;
    });
    return out;
  }, [events, span]);

  /** Entries introduced by this exact span — flagged JUST LOADED. */
  const justLoadedIds = useMemo<Set<string>>(() => {
    if (!span) return new Set();
    const s = new Set<string>();
    for (const l of ledgerSnapshot) {
      if (l.introducedBySpanId === span.id) s.add(l.id);
    }
    return s;
  }, [ledgerSnapshot, span]);

  const parentSpan = useMemo<SpanEvent | null>(() => {
    if (!span?.parentSpanId) return null;
    for (const e of events) {
      if (e.kind === 'span' && e.id === span.parentSpanId) return e;
    }
    return null;
  }, [events, span]);

  const childSpans = useMemo<SpanEvent[]>(() => {
    if (!span) return [];
    return events.filter((e): e is SpanEvent => e.kind === 'span' && e.parentSpanId === span.id);
  }, [events, span]);

  const spanTokens = useMemo(() => {
    if (!span) return 0;
    let t = 0;
    for (const e of events) {
      if (e.kind === 'ledger' && e.introducedBySpanId === span.id) {
        t += e.tokens ?? 0;
      }
    }
    if (t > 0) return t;
    return span.tokensConsumed ?? span.tokens ?? 0;
  }, [events, span]);

  /** Sum of ALL ledger tokens in this session (not just live-at-span). Drives
   *  the drawer-local `<ContextGauge />` which mirrors the top-of-page gauge
   *  so the user has the big-picture number in peripheral vision while
   *  scanning a span's detail. */
  const totalContextTokens = useMemo(() => {
    let t = 0;
    for (const e of events) {
      if (e.kind === 'ledger') t += e.tokens ?? 0;
    }
    return t;
  }, [events]);

  /** Source file path — pulled from sourceOffset on any attached ledger, or
   *  a `sourceFile` key in the span's metadata if the assembler wrote one. */
  const sourcePath = useMemo<string | null>(() => {
    if (!span) return null;
    const meta = span.metadata;
    if (
      meta &&
      typeof meta === 'object' &&
      typeof (meta as Record<string, unknown>).sourceFile === 'string'
    ) {
      return (meta as Record<string, string>).sourceFile;
    }
    for (const e of events) {
      if (e.kind === 'ledger' && e.introducedBySpanId === span.id && e.sourceOffset?.file) {
        return e.sourceOffset.file;
      }
    }
    return null;
  }, [events, span]);

  // L4.1 — close drawer by navigating URL back to /session/:id. Outside a
  // router, fall back to the store action.
  const handleClose = useCallback((): void => {
    if (navigate && selectedSessionId) {
      navigate(`/session/${encodeURIComponent(selectedSessionId)}`, { replace: false });
    } else {
      closeDrawer();
    }
  }, [navigate, selectedSessionId, closeDrawer]);

  // L4.3 — POST /api/open and show toast.
  const handleOpenSource = useCallback(async (): Promise<void> => {
    if (!sourcePath) return;
    try {
      await apiPost<{ ok: boolean; error?: string }>('/api/open', { path: sourcePath });
      setToast({ kind: 'ok', msg: 'Opened in default app' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ kind: 'err', msg });
    }
    // auto-dismiss
    setTimeout(() => setToast(null), 2800);
  }, [sourcePath]);

  // Parent navigation — jump to parent span (updates URL + drawer).
  const handleJumpToParent = useCallback((): void => {
    if (!parentSpan || !selectedSessionId) return;
    if (navigate) {
      navigate(
        `/session/${encodeURIComponent(selectedSessionId)}/span/${encodeURIComponent(parentSpan.id)}`
      );
    } else {
      selectSpan(parentSpan.id);
    }
  }, [navigate, parentSpan, selectedSessionId, selectSpan]);

  const handleJumpToChild = useCallback(
    (childId: string): void => {
      if (!selectedSessionId) return;
      if (navigate) {
        navigate(
          `/session/${encodeURIComponent(selectedSessionId)}/span/${encodeURIComponent(childId)}`
        );
      } else {
        selectSpan(childId);
      }
    },
    [navigate, selectedSessionId, selectSpan]
  );

  // Keep track: if selection moves to a new span we clear any hanging toast.
  // (Unmask plaintext lives inside <UnmaskButton>'s useRef — see L4.4.)
  if (!span) {
    void selectSpan; // referenced so lint is happy on the unused early return.
  }

  const nameIsSerif = span ? SERIF_TYPES.has(span.type) : false;

  return (
    <aside
      data-testid="inspector"
      data-open={drawerOpen ? 'true' : 'false'}
      aria-hidden={!drawerOpen}
      style={{
        // L4.1: width collapses to 0 when closed so the timeline gets the
        // full viewport. A tiny transition keeps the motion readable.
        width: drawerOpen ? 'var(--peek-inspector-w)' : 0,
        flexShrink: 0,
        background: 'var(--peek-surface)',
        borderLeft: drawerOpen ? '1px solid var(--peek-border)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 140ms ease-out',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 'var(--peek-inspector-w)',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        {!span ? (
          <div
            style={{
              padding: 24,
              color: 'var(--peek-fg-dim)',
              fontSize: 'var(--peek-fs-sm)',
            }}
          >
            select a timeline row to inspect.
          </div>
        ) : (
          <>
            <ContextGauge tokens={totalContextTokens} />
            <header
              style={{
                padding: '16px 20px 14px',
                borderBottom: '1px solid var(--peek-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span
                  className="peek-mono"
                  data-testid="inspector-type"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--peek-fg-faint)',
                  }}
                >
                  <span aria-hidden="true">{iconFor(span.type)}</span>
                  <span>{span.type}</span>
                </span>
                <button
                  type="button"
                  data-testid="inspector-close"
                  onClick={handleClose}
                  aria-label="close inspector (esc)"
                  className="peek-mono"
                  style={{
                    fontSize: 'var(--peek-fs-xs)',
                    letterSpacing: '0.04em',
                    color: 'var(--peek-fg-faint)',
                    padding: '2px 6px',
                    border: 'none',
                    background: 'transparent',
                  }}
                >
                  × esc
                </button>
              </div>

              <div
                data-testid="inspector-name"
                style={
                  nameIsSerif
                    ? {
                        fontFamily: '"Fraunces", Georgia, serif',
                        fontStyle: 'italic',
                        fontSize: 20,
                        color: 'var(--peek-fg)',
                        letterSpacing: '-0.01em',
                        fontWeight: 400,
                        wordBreak: 'break-word',
                      }
                    : {
                        fontSize: 'var(--peek-fs-lg)',
                        color: 'var(--peek-fg)',
                        wordBreak: 'break-word',
                      }
                }
              >
                {span.name ?? '(unnamed)'}
              </div>

              <div
                className="peek-mono"
                data-testid="inspector-meta"
                style={{
                  color: 'var(--peek-fg-faint)',
                  fontSize: 'var(--peek-fs-xs)',
                  letterSpacing: '0.04em',
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: 4,
                }}
              >
                {formatClock(span.startTs)}
                <span aria-hidden="true" style={{ margin: '0 6px' }}>
                  ·
                </span>
                dur{' '}
                <b style={{ color: 'var(--peek-accent)', fontWeight: 500 }}>
                  {formatDuration(span.durationMs)}
                </b>
                <span aria-hidden="true" style={{ margin: '0 6px' }}>
                  ·
                </span>
                <b style={{ color: 'var(--peek-accent)', fontWeight: 500 }}>
                  {formatTokens(spanTokens)}
                </b>{' '}
                tokens
              </div>
            </header>

            <div style={{ flex: 1, overflow: 'auto' }}>
              <Section label="parent" defaultOpen>
                {parentSpan ? (
                  <button
                    type="button"
                    data-testid="inspector-parent-link"
                    onClick={handleJumpToParent}
                    className="peek-mono"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--peek-fg)',
                      fontSize: 'var(--peek-fs-sm)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: 0,
                    }}
                  >
                    <span aria-hidden="true" style={{ marginRight: 6 }}>
                      {iconFor(parentSpan.type)}
                    </span>
                    <b style={{ fontWeight: 500 }}>{parentSpan.name ?? parentSpan.type}</b>
                    <span style={{ color: 'var(--peek-fg-faint)' }}> · {parentSpan.type}</span>
                  </button>
                ) : (
                  <Muted>— (root span)</Muted>
                )}
              </Section>

              <Section label="inputs" defaultOpen>
                <JsonBlock value={span.inputs} />
              </Section>

              <Section label="outputs" defaultOpen>
                <JsonBlock value={span.outputs} />
              </Section>

              <Section
                label={`context ledger · at this span (${ledgerSnapshot.length})`}
                defaultOpen
              >
                {ledgerSnapshot.length === 0 ? (
                  <Muted>no ledger entries live at this timestamp.</Muted>
                ) : (
                  <ul
                    data-testid="inspector-ledger"
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {ledgerSnapshot.map((l) => (
                      <LedgerRow key={l.id} entry={l} justLoaded={justLoadedIds.has(l.id)} />
                    ))}
                  </ul>
                )}
              </Section>

              <Section label={`children (${childSpans.length})`}>
                {childSpans.length === 0 ? (
                  <Muted>none.</Muted>
                ) : (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {childSpans.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          data-testid="inspector-child-link"
                          onClick={(): void => handleJumpToChild(c.id)}
                          className="peek-mono"
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--peek-fg)',
                            fontSize: 'var(--peek-fs-sm)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            padding: '2px 0',
                          }}
                        >
                          <span aria-hidden="true" style={{ marginRight: 6 }}>
                            {iconFor(c.type)}
                          </span>
                          {c.name ?? c.type}
                          <span style={{ color: 'var(--peek-fg-faint)' }}> · {c.type}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section label="source" defaultOpen>
                {sourcePath ? (
                  <>
                    <button
                      type="button"
                      data-testid="source-link"
                      onClick={(): void => {
                        void handleOpenSource();
                      }}
                      className="peek-mono"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--peek-accent)',
                        borderBottom: '1px dashed var(--peek-accent)',
                        fontSize: 'var(--peek-fs-sm)',
                        cursor: 'pointer',
                        padding: 0,
                        textAlign: 'left',
                        wordBreak: 'break-all',
                      }}
                      title={sourcePath}
                    >
                      {truncate(sourcePath, 56)}
                    </button>
                    <div
                      style={{
                        marginTop: 4,
                        color: 'var(--peek-fg-faint)',
                        fontSize: 'var(--peek-fs-xs)',
                      }}
                    >
                      [click → open in default app]
                    </div>
                  </>
                ) : (
                  <Muted>no source file attached.</Muted>
                )}
              </Section>
            </div>

            {toast && (
              <div
                role="status"
                data-testid="inspector-toast"
                style={{
                  padding: '8px 16px',
                  borderTop: '1px solid var(--peek-border)',
                  fontSize: 'var(--peek-fs-xs)',
                  color: toast.kind === 'ok' ? 'var(--peek-ok)' : 'var(--peek-bad)',
                  background: 'var(--peek-bg)',
                }}
              >
                {toast.msg}
              </div>
            )}

            <footer
              style={{
                padding: '10px 16px',
                borderTop: '1px solid var(--peek-border)',
                color: 'var(--peek-fg-faint)',
                fontSize: 10,
                letterSpacing: '0.12em',
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>esc close</span>
              <span className="peek-mono">{span.id.slice(0, 12)}</span>
            </footer>
          </>
        )}
      </div>
    </aside>
  );
}

function LedgerRow({
  entry,
  justLoaded,
}: {
  entry: LedgerEvent;
  justLoaded: boolean;
}): ReactElement {
  const preview = useMemo<string>(() => {
    const raw = entry.contentRedacted ?? '';
    return truncate(raw.replace(/\s+/g, ' ').trim(), 200);
  }, [entry.contentRedacted]);
  const redacted = looksRedacted(entry.contentRedacted ?? '');

  return (
    <li
      data-testid="ledger-entry"
      data-just-loaded={justLoaded ? 'true' : 'false'}
      style={{
        paddingBottom: 8,
        borderBottom: '1px solid var(--peek-border)',
      }}
    >
      <div
        className="peek-mono"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 11,
          color: 'var(--peek-fg-dim)',
        }}
      >
        <span>{entry.source ?? '—'}</span>
        {justLoaded && (
          <span
            data-testid="just-loaded-tag"
            className="peek-mono"
            style={{
              color: 'var(--peek-accent)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}
          >
            just loaded
          </span>
        )}
        <span
          className="peek-num"
          style={{
            marginLeft: 'auto',
            color: justLoaded ? 'var(--peek-accent)' : 'var(--peek-fg)',
          }}
        >
          {formatTokens(entry.tokens ?? 0)}
        </span>
      </div>
      {redacted ? (
        <UnmaskButton ledgerEntryId={entry.id} redacted={entry.contentRedacted} />
      ) : (
        <div
          className="peek-mono"
          style={{
            marginTop: 4,
            fontSize: 11,
            color: 'var(--peek-fg-dim)',
            wordBreak: 'break-word',
          }}
        >
          {preview || '—'}
        </div>
      )}
    </li>
  );
}

function Section({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}): ReactElement {
  return (
    <details
      open={defaultOpen}
      style={{
        borderBottom: '1px solid var(--peek-border)',
      }}
    >
      <summary
        className="peek-mono"
        style={{
          padding: '10px 20px',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--peek-fg-faint)',
          cursor: 'pointer',
          listStyle: 'revert',
        }}
      >
        {label}
      </summary>
      <div style={{ padding: '6px 20px 14px' }}>{children}</div>
    </details>
  );
}

function JsonBlock({ value }: { value: unknown }): ReactElement {
  if (value === undefined || value === null) {
    return <Muted>none.</Muted>;
  }
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre
      className="peek-mono"
      style={{
        margin: 0,
        padding: '8px',
        background: 'var(--peek-bg)',
        border: '1px solid var(--peek-border)',
        fontSize: 'var(--peek-fs-xs)',
        color: 'var(--peek-fg)',
        maxHeight: 280,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

function Muted({ children }: { children: ReactNode }): ReactElement {
  return (
    <div style={{ color: 'var(--peek-fg-faint)', fontSize: 'var(--peek-fs-sm)' }}>{children}</div>
  );
}

function looksRedacted(s: string): boolean {
  return /<secret:[^>]+>/.test(s);
}
