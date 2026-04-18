import type { ReactElement, ReactNode } from 'react';
/**
 * Right-side drawer. Plain `<aside>` that slides in on `data-open="true"`.
 * Sections are native `<details>` so keyboard / a11y come for free.
 */

import { useMemo } from 'react';

import { useSessionStore, type SpanEvent, type LedgerEvent } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { formatClock, formatDuration, formatTokens } from '../lib/format';
import { iconFor } from '../lib/icons';
import { ContextGauge } from './ContextGauge';
import { UnmaskButton } from './UnmaskButton';

export function Inspector(): ReactElement {
  const events = useSessionStore((s) => s.events);
  const selectedSpanId = useSelectionStore((s) => s.selectedSpanId);
  const drawerOpen = useSelectionStore((s) => s.drawerOpen);
  const closeDrawer = useSelectionStore((s) => s.closeDrawer);

  const span = useMemo<SpanEvent | null>(() => {
    if (!selectedSpanId) return null;
    for (const e of events) {
      if (e.kind === 'span' && e.id === selectedSpanId) return e;
    }
    return null;
  }, [events, selectedSpanId]);

  const ledgerForSpan = useMemo<LedgerEvent[]>(() => {
    if (!selectedSpanId) return [];
    return events.filter(
      (e): e is LedgerEvent => e.kind === 'ledger' && e.introducedBySpanId === selectedSpanId
    );
  }, [events, selectedSpanId]);

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

  const totalContextTokens = useMemo(() => {
    let t = 0;
    for (const e of events) {
      if (e.kind === 'ledger') t += e.tokens ?? 0;
    }
    return t;
  }, [events]);

  const spanTokens = useMemo(
    () => ledgerForSpan.reduce((n, l) => n + (l.tokens ?? 0), 0),
    [ledgerForSpan]
  );

  return (
    <aside
      data-testid="inspector"
      data-open={drawerOpen ? 'true' : 'false'}
      aria-hidden={!drawerOpen}
      style={{
        width: 'var(--peek-inspector-w)',
        flexShrink: 0,
        background: 'var(--peek-surface)',
        borderLeft: '1px solid var(--peek-border)',
        display: 'flex',
        flexDirection: 'column',
        transform: drawerOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 140ms ease-out',
        overflow: 'hidden',
      }}
    >
      <ContextGauge tokens={totalContextTokens} />

      <div style={{ flex: 1, overflow: 'auto' }}>
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
            <header
              style={{
                padding: '16px 16px 12px',
                borderBottom: '1px solid var(--peek-border)',
              }}
            >
              <div
                className="peek-mono"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 'var(--peek-fs-xs)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--peek-fg-dim)',
                }}
              >
                <span aria-hidden="true">{iconFor(span.type)}</span>
                <span>{span.type}</span>
              </div>
              <div
                data-testid="inspector-name"
                style={{
                  marginTop: 6,
                  fontSize: 'var(--peek-fs-lg)',
                  color: 'var(--peek-fg)',
                  wordBreak: 'break-word',
                }}
              >
                {span.name ?? '(unnamed)'}
              </div>
              <div
                className="peek-mono"
                style={{
                  marginTop: 12,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '4px 12px',
                  fontSize: 'var(--peek-fs-xs)',
                  color: 'var(--peek-fg-dim)',
                }}
              >
                <span>ts</span>
                <span className="peek-num" style={{ color: 'var(--peek-fg)' }}>
                  {formatClock(span.startTs)}
                </span>
                <span>dur</span>
                <span className="peek-num" style={{ color: 'var(--peek-fg)' }}>
                  {formatDuration(span.durationMs)}
                </span>
                <span>tokens</span>
                <span
                  className="peek-num"
                  style={{ color: 'var(--peek-fg)', fontSize: 'var(--peek-fs-md)' }}
                >
                  {formatTokens(spanTokens)}
                </span>
              </div>
            </header>

            <Section label="inputs" defaultOpen>
              <JsonBlock value={span.inputs} />
            </Section>
            <Section label="outputs" defaultOpen>
              <JsonBlock value={span.outputs} />
            </Section>
            <Section label={`context ledger (${ledgerForSpan.length})`}>
              {ledgerForSpan.length === 0 ? (
                <Muted>no ledger entries introduced by this span.</Muted>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {ledgerForSpan.map((l) => (
                    <li key={l.id}>
                      <div
                        className="peek-mono"
                        style={{
                          display: 'flex',
                          gap: 8,
                          fontSize: 'var(--peek-fs-xs)',
                          color: 'var(--peek-fg-dim)',
                        }}
                      >
                        <span>{l.source ?? '—'}</span>
                        <span
                          className="peek-num"
                          style={{ marginLeft: 'auto', color: 'var(--peek-fg)' }}
                        >
                          {formatTokens(l.tokens ?? 0)}
                        </span>
                      </div>
                      {l.contentRedacted !== undefined && looksRedacted(l.contentRedacted) ? (
                        <UnmaskButton ledgerEntryId={l.id} redacted={l.contentRedacted} />
                      ) : (
                        <code
                          className="peek-mono"
                          style={{
                            display: 'block',
                            padding: '6px 8px',
                            background: 'var(--peek-bg)',
                            border: '1px solid var(--peek-border)',
                            fontSize: 'var(--peek-fs-sm)',
                            wordBreak: 'break-word',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {l.contentRedacted ?? ''}
                        </code>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section label="parent / children">
              <dl
                className="peek-mono"
                style={{ margin: 0, fontSize: 'var(--peek-fs-xs)', color: 'var(--peek-fg-dim)' }}
              >
                <dt style={{ marginTop: 6 }}>parent</dt>
                <dd style={{ margin: '2px 0 8px', color: 'var(--peek-fg)' }}>
                  {parentSpan
                    ? `${parentSpan.type} · ${parentSpan.name ?? parentSpan.id}`
                    : '— (root)'}
                </dd>
                <dt>children ({childSpans.length})</dt>
                <dd style={{ margin: '2px 0 0', color: 'var(--peek-fg)' }}>
                  {childSpans.length === 0
                    ? 'none'
                    : childSpans.map((c) => c.name ?? c.type).join(', ')}
                </dd>
              </dl>
            </Section>
            <Section label="source">
              <code
                className="peek-mono"
                style={{
                  display: 'block',
                  padding: '6px 8px',
                  background: 'var(--peek-bg)',
                  border: '1px solid var(--peek-border)',
                  fontSize: 'var(--peek-fs-xs)',
                  color: 'var(--peek-fg-dim)',
                  wordBreak: 'break-all',
                }}
              >
                span:{span.id}
              </code>
            </Section>
          </>
        )}
      </div>

      <footer
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--peek-border)',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={closeDrawer}
          className="peek-mono"
          style={{
            fontSize: 'var(--peek-fs-xs)',
            padding: '4px 10px',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          close (esc)
        </button>
      </footer>
    </aside>
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
          padding: '10px 16px',
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--peek-fg-dim)',
          cursor: 'pointer',
          listStyle: 'revert',
        }}
      >
        {label}
      </summary>
      <div style={{ padding: '0 16px 12px' }}>{children}</div>
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
