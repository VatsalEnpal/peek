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
};
type LedgerEvent = {
  kind: 'ledger';
  id: string;
  sessionId: string;
  source?: string;
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

function flatten(events: TimelineEvent[]): {
  roots: TimelineEvent[];
  childrenByParent: Map<string, TimelineEvent[]>;
} {
  const childrenByParent = new Map<string, TimelineEvent[]>();
  const roots: TimelineEvent[] = [];
  for (const e of events) {
    const parent = e.kind === 'span' ? e.parentSpanId : undefined;
    if (parent && events.some((x) => x.id === parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(e);
      childrenByParent.set(parent, arr);
    } else {
      roots.push(e);
    }
  }
  return { roots, childrenByParent };
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
        const [sum, ev] = await Promise.all([
          apiGet<RecordingSummary>(`/api/recordings/${encodeURIComponent(id)}`),
          apiGet<TimelineEvent[]>(
            `/api/recordings/${encodeURIComponent(id)}/events${showLifecycle ? '?includeLifecycle=1' : ''}`
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
  }, [id, showLifecycle]);

  const tree = useMemo(() => flatten(events), [events]);

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
        ) : (
          tree.roots.map((e) => (
            <EventRow key={e.id} event={e} childrenMap={tree.childrenByParent} indent={0} />
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
  childrenMap,
  indent,
}: {
  event: TimelineEvent;
  childrenMap: Map<string, TimelineEvent[]>;
  indent: number;
}): ReactElement {
  if (event.kind === 'span' && event.type === 'subagent') {
    return <SubagentGroup event={event} childrenMap={childrenMap} indent={indent} />;
  }
  if (event.kind === 'span' && LIFECYCLE_TYPES.has(event.type)) {
    return <ToolRow event={event} indent={indent} lifecycle />;
  }
  return <ToolRow event={event} indent={indent} />;
}

function SubagentGroup({
  event,
  childrenMap,
  indent,
}: {
  event: SpanEvent;
  childrenMap: Map<string, TimelineEvent[]>;
  indent: number;
}): ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  const kids = childrenMap.get(event.id) ?? [];
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
      {open && (
        <div style={{ marginTop: 6 }}>
          {kids.map((k) => (
            <EventRow key={k.id} event={k} childrenMap={childrenMap} indent={indent + 1} />
          ))}
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
              textTransform: 'uppercase',
              marginRight: 8,
            }}
          >
            {kind}
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
