/**
 * Recording detail page — v0.3 L4.
 *
 * The "Ctrl+O" view for a single recording. Renders:
 *   - a header (name, started, duration, per-stat badges)
 *   - a filter chip to surface hidden Claude Code lifecycle events
 *   - a vertical timeline of the recording's events (bounded by session +
 *     [startTs..endTs])
 *   - tool_call / api_call rows collapse to a one-liner and expand in place
 *     to show inputs + outputs
 *   - subagent spans render as nested groups with the agentId and description
 *     surfaced in the header; children (events whose parentSpanId matches)
 *     render indented inside the group
 *
 * Scroll fix (L4.4): outer shell is 100dvh/overflow:hidden; the timeline
 * itself is the flex:1 / overflow:auto child. Keeps the top bar + back link
 * pinned while the event log scrolls independently.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { apiGet } from '../lib/api';
import type { RecordingSummary } from '../stores/recordings';

type SpanEvent = {
  kind: 'span';
  id: string;
  sessionId: string;
  turnId?: string;
  parentSpanId?: string;
  type: string;
  name?: string;
  startTs?: string;
  endTs?: string;
  durationMs?: number;
  tokensConsumed?: number;
  tokens?: number;
  inputs?: unknown;
  outputs?: unknown;
  metadata?: Record<string, unknown>;
  childSpanIds?: string[];
};
type LedgerEvent = {
  kind: 'ledger';
  id: string;
  sessionId: string;
  source?: string;
  /**
   * v0.3-resume #12: when the server returns both a span AND the ledger entry
   * that introduced it, dedupe by dropping the ledger row whose
   * `introducedBySpanId` resolves to a span in the same payload.
   */
  introducedBySpanId?: string;
  tokens?: number;
  contentRedacted?: string;
  ts?: string;
};
type TimelineEvent = SpanEvent | LedgerEvent;

const LIFECYCLE_TYPES = new Set([
  'bridge_status',
  'command_permissions',
  'mcp_instructions_delta',
  'deferred_tools_delta',
  'stop_hook_summary',
  'auto_mode',
  'turn_duration',
  'file-history-snapshot',
  'permission-mode',
  'away_summary',
  'last-prompt',
  'queue-operation',
  'task_reminder',
]);

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function iconFor(type: string): string {
  if (type === 'user_prompt') return '🗨';
  if (type === 'api_call') return '🤖';
  if (type === 'subagent') return '👥';
  if (type === 'skill_activation') return '✨';
  if (type === 'mcp_call') return '🧩';
  if (type === 'thinking_block') return '💭';
  if (type === 'hook_fire') return '🪝';
  if (type === 'memory_read') return '🧠';
  return '▸';
}

function tokensOf(e: TimelineEvent): number | undefined {
  if (e.kind === 'span') return e.tokensConsumed ?? e.tokens;
  return e.tokens;
}

function describeTarget(e: SpanEvent): string {
  if (typeof e.name === 'string' && e.name.length > 0) return e.name;
  return e.type;
}

/**
 * v0.3-resume:
 *  1. Drop ledger rows whose `introducedBySpanId` resolves to a rendered
 *     span — eliminates the `LEDGER tool_use` / `TOOL_CALL Bash` duplicate
 *     pair (#12).
 *  2. In default view (showDebug=false) drop the remaining ledger rows,
 *     spans whose `type` is in LIFECYCLE_TYPES, and catch-all `type:'unknown'`
 *     spans — the "show internal events" toggle reveals all three (#11).
 */
function filterVisible(events: TimelineEvent[], showDebug: boolean): TimelineEvent[] {
  const spanIds = new Set<string>();
  for (const e of events) if (e.kind === 'span') spanIds.add(e.id);
  return events.filter((e) => {
    if (e.kind === 'ledger') {
      if (e.introducedBySpanId && spanIds.has(e.introducedBySpanId)) return false;
      if (!showDebug) return false;
      return true;
    }
    // span
    if (!showDebug) {
      if (LIFECYCLE_TYPES.has(e.type)) return false;
      if (e.type === 'unknown') return false;
    }
    return true;
  });
}

/**
 * Build a tree over the filtered event list:
 *  - childrenByParent maps span.id → events whose parentSpanId points at it
 *  - subagentDescendants maps subagent.id → every transitive descendant
 *    (for the group's "N children" counter AND for excluding them from the
 *    top-level roots so they render only inside the group) (#14)
 */
function buildTree(events: TimelineEvent[]): {
  roots: TimelineEvent[];
  childrenByParent: Map<string, TimelineEvent[]>;
  subagentDescendants: Map<string, TimelineEvent[]>;
} {
  const byId = new Map<string, TimelineEvent>();
  for (const e of events) byId.set(e.id, e);

  const childrenByParent = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const parent = e.kind === 'span' ? e.parentSpanId : undefined;
    if (parent && byId.has(parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(e);
      childrenByParent.set(parent, arr);
    }
  }

  const subagentDescendants = new Map<string, TimelineEvent[]>();
  const descendantOfSubagent = new Set<string>();
  for (const e of events) {
    if (!(e.kind === 'span' && e.type === 'subagent')) continue;
    const descendants: TimelineEvent[] = [];
    const queue: TimelineEvent[] = [...(childrenByParent.get(e.id) ?? [])];
    // The subagent-joiner also stamps `childSpanIds` on the parent — seed the
    // queue from that metadata so grouping survives even if the stitched
    // children carry a different `parentSpanId` (depth-1 nested tool_uses
    // whose assembler-assigned parent is the child session's assistant
    // message, not the parent subagent span itself).
    const declared = Array.isArray(e.childSpanIds) ? e.childSpanIds : [];
    for (const childId of declared) {
      const child = byId.get(childId);
      if (child) queue.push(child);
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const d = queue.shift() as TimelineEvent;
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      descendants.push(d);
      const kids = childrenByParent.get(d.id) ?? [];
      for (const k of kids) queue.push(k);
    }
    subagentDescendants.set(e.id, descendants);
    for (const d of descendants) descendantOfSubagent.add(d.id);
  }

  const roots = events.filter((e) => !descendantOfSubagent.has(e.id));
  return { roots, childrenByParent, subagentDescendants };
}

export function RecordingDetailPage(): ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [summary, setSummary] = useState<RecordingSummary | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showLifecycle, setShowLifecycle] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Always request the full event set (includeLifecycle=1). Filtering
        // now happens client-side in `filterVisible` so the toggle can flip
        // in <16ms without a round-trip. The server-side filter would miss
        // LEDGER rows and `type:'unknown'` spans anyway — v0.3-resume #11.
        const [sum, ev] = await Promise.all([
          apiGet<RecordingSummary>(`/api/recordings/${encodeURIComponent(id)}`),
          apiGet<TimelineEvent[]>(
            `/api/recordings/${encodeURIComponent(id)}/events?includeLifecycle=1`
          ),
        ]);
        if (!cancelled) {
          setSummary(sum);
          setEvents(ev);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load recording');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const visibleEvents = useMemo(
    () => filterVisible(events, showLifecycle),
    [events, showLifecycle]
  );
  const tree = useMemo(() => buildTree(visibleEvents), [visibleEvents]);

  return (
    <div
      data-testid="recording-detail-page"
      data-height="100dvh"
      style={{
        height: '100dvh',
        overflow: 'hidden',
        background: 'var(--peek-bg)',
        color: 'var(--peek-fg)',
        fontFamily: 'var(--peek-font-mono)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* top bar */}
      <div
        style={{
          flex: '0 0 auto',
          borderBottom: '1px solid var(--peek-border)',
          background: 'var(--peek-surface)',
          padding: '14px 40px',
          display: 'flex',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <Link
          to="/"
          data-testid="recording-back"
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
        >
          ← back to recordings
        </Link>
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--peek-fg-faint)', fontSize: 10, letterSpacing: '0.1em' }}>
          peek 0.3
        </span>
      </div>

      {/* header */}
      <Header summary={summary} id={id} />

      {/* filter chips row */}
      <div
        style={{
          flex: '0 0 auto',
          padding: '10px 40px',
          borderBottom: '1px solid var(--peek-border)',
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          type="button"
          data-testid="lifecycle-toggle"
          onClick={(): void => setShowLifecycle((v) => !v)}
          style={{
            border: '1px solid var(--peek-border)',
            color: showLifecycle ? 'var(--peek-accent)' : 'var(--peek-fg-faint)',
            background: showLifecycle ? 'rgba(255,180,84,0.06)' : 'transparent',
            padding: '4px 10px',
            fontSize: 10,
            letterSpacing: '0.1em',
            cursor: 'pointer',
            textTransform: 'lowercase',
            fontFamily: 'inherit',
          }}
        >
          {showLifecycle ? '● ' : '○ '}show internal events
        </button>
      </div>

      {/* timeline — the scrolling surface */}
      <div
        data-testid="recording-timeline"
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px 40px 64px',
        }}
      >
        {error !== null ? (
          <div style={{ padding: 16, color: 'var(--peek-bad)' }}>{error}</div>
        ) : events.length === 0 ? (
          <div
            style={{
              padding: 48,
              color: 'var(--peek-fg-faint)',
              fontSize: 'var(--peek-fs-sm)',
              textAlign: 'center',
            }}
          >
            no events captured in this window
          </div>
        ) : tree.roots.length === 0 ? (
          <div
            style={{
              padding: 48,
              color: 'var(--peek-fg-faint)',
              fontSize: 'var(--peek-fs-sm)',
              textAlign: 'center',
            }}
          >
            only internal events in this window — toggle "show internal events" to see them
          </div>
        ) : (
          tree.roots.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              subagentDescendants={tree.subagentDescendants}
              indent={0}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Header({ summary, id }: { summary: RecordingSummary | null; id: string }): ReactElement {
  return (
    <div
      data-testid="recording-detail-header"
      style={{
        flex: '0 0 auto',
        padding: '22px 40px',
        borderBottom: '1px solid var(--peek-border)',
        background: 'var(--peek-surface)',
      }}
    >
      <div
        style={{
          fontFamily: '"Fraunces", Georgia, serif',
          fontStyle: 'italic',
          color: 'var(--peek-fg)',
          fontSize: 'var(--peek-fs-xl)',
          letterSpacing: '-0.01em',
          marginBottom: 6,
        }}
      >
        {summary?.name ?? id}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 20,
          color: 'var(--peek-fg-dim)',
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.04em',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--peek-font-mono)',
        }}
      >
        <span>{summary ? formatTime(summary.startTs) : '—'}</span>
        <Divider />
        <span>{summary ? formatDuration(summary.durationMs) : '—'}</span>
        <Divider />
        <span>
          {summary?.toolCount.toLocaleString('en-US') ?? '0'}
          <span style={{ color: 'var(--peek-fg-faint)' }}> tools</span>
        </span>
        <Divider />
        <span>
          {summary?.apiCount.toLocaleString('en-US') ?? '0'}
          <span style={{ color: 'var(--peek-fg-faint)' }}> api</span>
        </span>
        <Divider />
        <span>
          {summary?.totalTokens.toLocaleString('en-US') ?? '0'}
          <span style={{ color: 'var(--peek-fg-faint)' }}> tokens</span>
        </span>
      </div>
    </div>
  );
}

function Divider(): ReactElement {
  return <span style={{ color: 'var(--peek-border)' }}>·</span>;
}

function EventRow({
  event,
  subagentDescendants,
  indent,
}: {
  event: TimelineEvent;
  subagentDescendants: Map<string, TimelineEvent[]>;
  indent: number;
}): ReactElement {
  if (event.kind === 'span' && event.type === 'subagent') {
    return (
      <SubagentGroup
        event={event}
        descendants={subagentDescendants.get(event.id) ?? []}
        indent={indent}
      />
    );
  }
  if (event.kind === 'span' && LIFECYCLE_TYPES.has(event.type)) {
    return <ToolRow event={event} indent={indent} lifecycle />;
  }
  return <ToolRow event={event} indent={indent} />;
}

function SubagentGroup({
  event,
  descendants,
  indent,
}: {
  event: SpanEvent;
  descendants: TimelineEvent[];
  indent: number;
}): ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  // v0.3-resume #14: the subagent group's "N children" counter and nested
  // rows use the transitive descendant list — a subagent with 3 tool calls
  // (even when some are grandchildren via the assembler's message-uuid
  // parentage) reports "3 children".
  const kids = descendants;
  const meta = (event.metadata ?? {}) as Record<string, unknown>;
  const agentId = typeof meta.agentId === 'string' ? meta.agentId : '';
  const description = typeof meta.description === 'string' ? meta.description : '';

  return (
    <div
      data-testid={`subagent-group-${event.id}`}
      style={{
        margin: '10px 0 10px',
        marginLeft: indent * 20,
        borderLeft: '2px solid var(--peek-accent)',
        background: 'linear-gradient(90deg, rgba(255,180,84,0.04) 0%, rgba(255,180,84,0) 60%)',
        padding: '8px 0 8px 12px',
      }}
    >
      <button
        type="button"
        data-testid={`subagent-group-toggle-${event.id}`}
        aria-expanded={open}
        aria-label={open ? 'collapse subagent' : 'expand subagent'}
        onClick={(): void => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 'var(--peek-fs-sm)',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            color: 'var(--peek-fg-faint)',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 100ms ease',
            display: 'inline-block',
            width: 10,
          }}
        >
          ▸
        </span>
        <span style={{ color: 'var(--peek-fg-faint)', minWidth: 64 }}>
          {formatTime(event.startTs)}
        </span>
        <span>{iconFor('subagent')}</span>
        <span
          style={{
            color: 'var(--peek-accent)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            fontSize: 10,
          }}
        >
          subagent
        </span>
        <span style={{ color: 'var(--peek-fg)', fontWeight: 500 }}>{event.name ?? 'Agent'}</span>
        {agentId.length > 0 && (
          <span style={{ color: 'var(--peek-fg-faint)', fontSize: 10 }}>({agentId})</span>
        )}
        {description.length > 0 && (
          <span
            style={{
              color: 'var(--peek-fg-dim)',
              fontStyle: 'italic',
              fontFamily: '"Fraunces", Georgia, serif',
              fontSize: 'var(--peek-fs-sm)',
            }}
          >
            — {description}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            letterSpacing: '0.06em',
          }}
        >
          {kids.length} {kids.length === 1 ? 'child' : 'children'}
        </span>
      </button>
      {open && kids.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {kids.map((k) =>
            k.kind === 'span' && LIFECYCLE_TYPES.has(k.type) ? (
              <ToolRow key={k.id} event={k} indent={indent + 1} lifecycle />
            ) : (
              <ToolRow key={k.id} event={k} indent={indent + 1} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({
  event,
  indent,
  lifecycle,
}: {
  event: TimelineEvent;
  indent: number;
  lifecycle?: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState<boolean>(false);
  const span = event.kind === 'span' ? event : null;
  const tokens = tokensOf(event);
  const rowColor = lifecycle ? 'var(--peek-fg-faint)' : 'var(--peek-fg-dim)';

  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '24px 72px 24px 1fr auto 24px',
    alignItems: 'baseline',
    gap: 10,
    padding: '4px 0',
    marginLeft: indent * 20,
    fontSize: 'var(--peek-fs-sm)',
    color: rowColor,
    fontVariantNumeric: 'tabular-nums',
    borderLeft: lifecycle ? '1px dashed var(--peek-border)' : 'none',
    paddingLeft: lifecycle ? 6 : 0,
  };

  const label = span ? describeTarget(span) : (event.source ?? 'ledger');
  const kind = span ? span.type : 'ledger';

  return (
    <div data-testid={`tool-row-${event.id}`} style={{ marginBottom: 0 }}>
      <div style={rowStyle}>
        <span />
        <span style={{ color: 'var(--peek-fg-faint)', fontSize: 10 }}>
          {formatTime(span?.startTs ?? (event as LedgerEvent).ts)}
        </span>
        <span>{iconFor(kind)}</span>
        <span>
          <span
            style={{
              color: 'var(--peek-fg-faint)',
              fontSize: 10,
              letterSpacing: '0.06em',
              marginRight: 8,
            }}
          >
            {kind.toUpperCase()}
          </span>
          <span style={{ color: 'var(--peek-fg)', fontWeight: 500 }}>{label}</span>
        </span>
        <span>
          {tokens !== undefined && (
            <span style={{ color: 'var(--peek-fg-dim)' }}>{tokens.toLocaleString('en-US')}</span>
          )}
        </span>
        <button
          type="button"
          data-testid={`tool-row-toggle-${event.id}`}
          onClick={(): void => setExpanded((v) => !v)}
          aria-label={expanded ? 'collapse details' : 'expand details'}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--peek-fg-faint)',
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit',
            fontSize: 10,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 100ms ease',
          }}
        >
          ▸
        </button>
      </div>
      {expanded && span && (
        <div
          data-testid={`tool-row-body-${event.id}`}
          style={{
            marginLeft: indent * 20 + 106,
            marginTop: 4,
            marginBottom: 10,
            padding: 10,
            border: '1px solid var(--peek-border)',
            background: 'var(--peek-surface-2)',
            fontSize: 11,
            color: 'var(--peek-fg-dim)',
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {span.inputs !== undefined && (
            <Section title="inputs">
              <Pre value={span.inputs} />
            </Section>
          )}
          {span.outputs !== undefined && (
            <Section title="outputs">
              <Pre value={span.outputs} />
            </Section>
          )}
          {span.metadata !== undefined && Object.keys(span.metadata as object).length > 0 && (
            <Section title="metadata">
              <Pre value={span.metadata} />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactElement }): ReactElement {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          color: 'var(--peek-fg-faint)',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Pre({ value }: { value: unknown }): ReactElement {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > 2000) text = text.slice(0, 2000) + '\n… (truncated)';
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'var(--peek-font-mono)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--peek-fg)',
      }}
    >
      {text}
    </pre>
  );
}
