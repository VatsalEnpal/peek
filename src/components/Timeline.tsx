import type { ReactElement, ReactNode } from 'react';
/**
 * Flat-DOM scrollable timeline. Consumes `buildTimelineRows` from the store
 * and wires selection + expand-cascade into the two zustand stores.
 */

import { useMemo } from 'react';

import { useSessionStore, buildTimelineRows, type LedgerEvent } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { TimelineRow } from './TimelineRow';

export function Timeline(): ReactElement {
  const events = useSessionStore((s) => s.events);
  const loading = useSessionStore((s) => s.eventsLoading);
  const error = useSessionStore((s) => s.eventsError);
  const active = useSessionStore((s) => s.activeChips);
  const expanded = useSessionStore((s) => s.expandedSpans);
  const toggleExpand = useSessionStore((s) => s.toggleSpanExpanded);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);

  const selectedSpanId = useSelectionStore((s) => s.selectedSpanId);
  const selectSpan = useSelectionStore((s) => s.selectSpan);

  const rows = useMemo(
    () => buildTimelineRows(events, active, expanded),
    [events, active, expanded]
  );

  const tokensBySpan = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      if (e.kind !== 'ledger') continue;
      const l = e as LedgerEvent;
      if (!l.introducedBySpanId) continue;
      m.set(l.introducedBySpanId, (m.get(l.introducedBySpanId) ?? 0) + (l.tokens ?? 0));
    }
    return m;
  }, [events]);

  if (!selectedSessionId) {
    return (
      <Empty>
        <div>no session selected</div>
        <div className="peek-dim" style={{ fontSize: 'var(--peek-fs-sm)', marginTop: 8 }}>
          pick one from the dropdown above
        </div>
      </Empty>
    );
  }
  if (loading) {
    return <Empty>loading events…</Empty>;
  }
  if (error !== null) {
    return (
      <Empty>
        <div style={{ color: 'var(--peek-bad)' }}>failed to load events</div>
        <div className="peek-dim peek-mono" style={{ fontSize: 'var(--peek-fs-xs)', marginTop: 8 }}>
          {error}
        </div>
      </Empty>
    );
  }
  if (rows.length === 0) {
    return <Empty>no events match the active filters</Empty>;
  }

  return (
    <div
      data-testid="timeline"
      style={{
        flex: 1,
        overflow: 'auto',
        paddingTop: 'var(--peek-sp-2)',
        paddingBottom: 'var(--peek-sp-4)',
      }}
    >
      {rows.map((r) => (
        <TimelineRow
          key={r.id}
          span={r}
          depth={r.depth}
          hasChildren={r.hasChildren}
          expanded={expanded.has(r.id)}
          selected={selectedSpanId === r.id}
          tokens={tokensBySpan.get(r.id) ?? null}
          onSelect={(): void => selectSpan(r.id)}
          onToggleExpand={(): void => toggleExpand(r.id)}
        />
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      data-testid="timeline-empty"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--peek-fg-dim)',
        fontSize: 'var(--peek-fs-md)',
        textAlign: 'center',
        padding: 32,
      }}
    >
      {children}
    </div>
  );
}
