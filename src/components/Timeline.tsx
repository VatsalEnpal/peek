import type { ReactElement, ReactNode } from 'react';
/**
 * Flat-DOM scrollable timeline. Consumes `buildTimelineRows` from the store
 * and wires selection + cascade-collapse into the two zustand stores.
 *
 * Click behaviour (L3.2):
 *   - Clicking a row calls `useSelectionStore.selectSpan(id)` which opens the
 *     Inspector drawer, AND also navigates to `/session/:id/span/:spanId` so
 *     the URL deep-links to the drawer state.
 *
 * Cascade (L3.4 — Option B layer on top of Option A flatten):
 *   - Children of a collapsed ancestor are hidden via `hiddenByCollapse`.
 *   - Default state = expanded (no entries in expandedSpans + a sentinel:
 *     "collapsed" is opt-in). A span is considered collapsed iff its id is in
 *     the `collapsedSpans` Set (we use the inverse of `expandedSpans` below
 *     for v0.2 to avoid an extra store field). That keeps the regression-test
 *     "tool_calls must be visible" finding green while giving users a way to
 *     silence noise.
 */

import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useSessionStore, buildTimelineRows, type LedgerEvent } from '../stores/session';
import { useSelectionStore, inFocusRange } from '../stores/selection';
import { TimelineRow } from './TimelineRow';

export function Timeline(): ReactElement {
  const events = useSessionStore((s) => s.events);
  const loading = useSessionStore((s) => s.eventsLoading);
  const error = useSessionStore((s) => s.eventsError);
  const active = useSessionStore((s) => s.activeChips);
  const expanded = useSessionStore((s) => s.expandedSpans);
  const collapsed = useSessionStore((s) => s.collapsedSpans);
  const toggleCollapse = useSessionStore((s) => s.toggleSpanCollapsed);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);

  const selectedSpanId = useSelectionStore((s) => s.selectedSpanId);
  const selectSpan = useSelectionStore((s) => s.selectSpan);
  const focusRange = useSelectionStore((s) => s.focusRange);

  const navigate = useNavigate();
  const params = useParams<{ id: string }>();

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

  /**
   * Prefer the ledger-aggregated token count; fall back to the span's own
   * `tokensConsumed` (or `tokens`) field when present.
   * A resolved value of `0` renders as "0" (not "—"); only null/undefined is "—".
   */
  const tokensFor = (r: {
    id: string;
    tokensConsumed?: number;
    tokens?: number;
  }): number | null => {
    const fromLedger = tokensBySpan.get(r.id);
    if (typeof fromLedger === 'number' && fromLedger > 0) return fromLedger;
    if (typeof r.tokensConsumed === 'number') return r.tokensConsumed;
    if (typeof r.tokens === 'number') return r.tokens;
    return null;
  };

  /**
   * Map of span-id → "is hidden because some ancestor is collapsed".
   *
   * We walk the dedup'd span set so orphans (parentSpanId points outside the
   * payload) are treated as roots and never hidden. A cycle guard (visited
   * set) keeps malformed data from looping forever.
   */
  const hiddenByCollapse = useMemo(() => {
    if (collapsed.size === 0) return new Set<string>();
    const parent = new Map<string, string | undefined>();
    for (const r of rows) parent.set(r.id, r.parentSpanId);
    const hidden = new Set<string>();
    for (const r of rows) {
      let cur: string | undefined = r.parentSpanId;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        if (collapsed.has(cur)) {
          hidden.add(r.id);
          break;
        }
        cur = parent.get(cur);
      }
    }
    return hidden;
  }, [rows, collapsed]);

  if (!selectedSessionId) {
    return (
      <Empty>
        <div>no session selected</div>
        <div className="peek-dim" style={{ fontSize: 'var(--peek-fs-sm)', marginTop: 8 }}>
          pick one from the landing page
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

  const handleSelect = (id: string): void => {
    selectSpan(id);
    // URL sync — deep-link to the drawer so refresh preserves state.
    const sessId = params.id ?? selectedSessionId;
    if (sessId) {
      navigate(`/session/${encodeURIComponent(sessId)}/span/${encodeURIComponent(id)}`, {
        replace: false,
      });
    }
  };

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
          expanded={!collapsed.has(r.id)}
          selected={selectedSpanId === r.id}
          tokens={tokensFor(r)}
          inRange={inFocusRange(r.startTs, focusRange)}
          hiddenByCollapse={hiddenByCollapse.has(r.id)}
          onSelect={(): void => handleSelect(r.id)}
          onToggleExpand={(): void => toggleCollapse(r.id)}
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
