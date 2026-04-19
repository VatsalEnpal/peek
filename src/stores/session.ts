/**
 * Session + timeline-event store.
 *
 * Responsibilities:
 *   - Fetch the session list from `/api/sessions`.
 *   - Track `selectedSessionId` and fetch its events from
 *     `/api/sessions/:id/events`.
 *   - Filter chips (prompts/files/skills/hooks/api/tools/subagents) whose
 *     active set is a source of truth the Timeline reads.
 *
 * Kept tiny on purpose — no caching, no query-key plumbing. Plain fetch in an
 * async action is enough for v0.1.
 */

import { create } from 'zustand';

import { apiGet } from '../lib/api';
import type { SpanType } from '../lib/icons';
import { CHIP_DEFS } from '../lib/icons';

export type SessionSummary = {
  id: string;
  label: string;
  firstPrompt: string | null;
  turnCount: number;
  totalTokens: number;
  timeAgo: string;
  startTs: string | null;
  endTs: string | null;
};

export type SpanEvent = {
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
  /**
   * Optional per-span token attribution set by the pipeline.
   * Some builders emit `tokensConsumed` (preferred); others emit `tokens`.
   * The Timeline reads `tokensConsumed ?? tokens` as a fallback when no
   * ledger rows exist for the span.
   */
  tokensConsumed?: number;
  tokens?: number;
  inputs?: unknown;
  outputs?: unknown;
  metadata?: Record<string, unknown>;
};

export type LedgerEvent = {
  kind: 'ledger';
  id: string;
  sessionId: string;
  turnId?: string;
  introducedBySpanId?: string;
  source?: string;
  tokens?: number;
  contentRedacted?: string;
  ts?: string;
  sourceOffset?: {
    file: string;
    byteStart: number;
    byteEnd: number;
    sourceLineHash: string;
  };
};

export type StoreEvent = SpanEvent | LedgerEvent;

export type ChipKey = (typeof CHIP_DEFS)[number]['key'];

export type SessionState = {
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string | null;

  selectedSessionId: string | null;
  events: StoreEvent[];
  eventsLoading: boolean;
  eventsError: string | null;

  activeChips: Set<ChipKey>;
  expandedSpans: Set<string>;

  fetchSessions: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  refetchEvents: () => Promise<void>;
  toggleChip: (k: ChipKey) => void;
  toggleSpanExpanded: (spanId: string) => void;
  expandSpan: (spanId: string) => void;
  collapseSpan: (spanId: string) => void;
};

const allChips = new Set<ChipKey>(CHIP_DEFS.map((c) => c.key));

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  sessionsLoading: false,
  sessionsError: null,

  selectedSessionId: null,
  events: [],
  eventsLoading: false,
  eventsError: null,

  activeChips: allChips,
  expandedSpans: new Set(),

  async fetchSessions() {
    set({ sessionsLoading: true, sessionsError: null });
    try {
      const sessions = await apiGet<SessionSummary[]>('/api/sessions');
      set({ sessions, sessionsLoading: false });
      // Auto-select the most recent session if nothing is selected.
      if (!get().selectedSessionId && sessions.length > 0) {
        await get().selectSession(sessions[0]!.id);
      }
    } catch (err) {
      set({
        sessionsLoading: false,
        sessionsError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async selectSession(id) {
    set({ selectedSessionId: id, events: [], eventsError: null });
    if (id === null) return;
    await get().refetchEvents();
  },

  async refetchEvents() {
    const id = get().selectedSessionId;
    if (!id) return;
    set({ eventsLoading: true, eventsError: null });
    try {
      const events = await apiGet<StoreEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events`);
      set({ events, eventsLoading: false });
    } catch (err) {
      set({
        eventsLoading: false,
        eventsError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  toggleChip(k) {
    const next = new Set(get().activeChips);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    set({ activeChips: next });
  },

  toggleSpanExpanded(spanId) {
    const next = new Set(get().expandedSpans);
    if (next.has(spanId)) next.delete(spanId);
    else next.add(spanId);
    set({ expandedSpans: next });
  },
  expandSpan(spanId) {
    const cur = get().expandedSpans;
    if (cur.has(spanId)) return;
    const next = new Set(cur);
    next.add(spanId);
    set({ expandedSpans: next });
  },
  collapseSpan(spanId) {
    const cur = get().expandedSpans;
    if (!cur.has(spanId)) return;
    const next = new Set(cur);
    next.delete(spanId);
    set({ expandedSpans: next });
  },
}));

/** Returns true if a span's type matches any currently-active chip. */
export function spanVisible(type: string, active: Set<ChipKey>): boolean {
  // A span is visible unless its type is explicitly matched by an inactive chip.
  // Types not covered by any chip are always visible (e.g. thinking/system).
  for (const def of CHIP_DEFS) {
    if (def.matches.includes(type)) {
      return active.has(def.key as ChipKey);
    }
  }
  return true;
}

/**
 * Build a display list — respects chip filters.
 *
 * Design (Option A, flat chronological stream — v0.2):
 *   - Every span that passes the chip filter is emitted exactly once.
 *   - Sort by startTs ascending with null/invalid timestamps sunk to the bottom
 *     so the viewport shows real chronological events first.
 *   - `depth` is computed from the parentSpanId chain length (capped at 4) so
 *     children are visually indented, without requiring an expand click.
 *   - Orphan children (parentSpanId points at a span that was filtered out or
 *     was never ingested — common for subagent cross-session boundaries) are
 *     rescued as root-level rows rather than silently dropped.
 *   - Duplicate span ids collapse to the first occurrence.
 *   - `expanded` is kept in the signature for forward compatibility with a
 *     future Option B cascade UI; in Option A every child is already visible
 *     so the set is unused. `hasChildren` still lights up the ▶ marker so
 *     users can visually see the parent/child relationship.
 *
 * Ledger entries are dropped from the flat timeline — they surface in the
 * inspector; the user cares about spans at this level.
 */
// Cap how deep we'll indent so a pathologically-nested trace can't push the
// name column off-screen. 4 levels * 2ch = 8ch of left padding, plenty.
const MAX_DEPTH = 4;

export function buildTimelineRows(
  events: StoreEvent[],
  active: Set<ChipKey>,
  _expanded: Set<string>
): Array<SpanEvent & { depth: number; hasChildren: boolean }> {
  void _expanded; // reserved for cascade re-introduction; see docstring.

  // 1. Pull spans + dedupe by id (guard against duplicate ingestion).
  const byId = new Map<string, SpanEvent>();
  for (const e of events) {
    if (e.kind !== 'span') continue;
    if (!byId.has(e.id)) byId.set(e.id, e);
  }

  // 2. Count direct children per span so we can render the ▶ indicator.
  const childCount = new Map<string, number>();
  for (const s of byId.values()) {
    const p = s.parentSpanId;
    if (!p) continue;
    if (!byId.has(p)) continue; // orphan — not a real parent in this payload.
    childCount.set(p, (childCount.get(p) ?? 0) + 1);
  }

  // 3. Compute depth by walking the parent chain. Orphan parentSpanId (pointing
  //    at a span that isn't in the payload) is treated as a root (depth 0).
  //    Guard against malformed cycles with a visited set + explicit cap.
  const depthOf = (span: SpanEvent): number => {
    let d = 0;
    let cur: SpanEvent | undefined = span;
    const seen = new Set<string>();
    while (cur && cur.parentSpanId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = byId.get(cur.parentSpanId);
      if (!parent) break; // orphan — stop here, treat as root-of-chain.
      d += 1;
      if (d >= MAX_DEPTH) return MAX_DEPTH;
      cur = parent;
    }
    return d;
  };

  // 4. Filter by chip + attach computed fields.
  const tsRank = (s: SpanEvent): number => {
    if (!s.startTs) return Number.POSITIVE_INFINITY;
    const n = Date.parse(s.startTs);
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
  };

  const rows: Array<SpanEvent & { depth: number; hasChildren: boolean }> = [];
  for (const s of byId.values()) {
    if (!spanVisible(s.type, active)) continue;
    rows.push({
      ...s,
      depth: depthOf(s),
      hasChildren: (childCount.get(s.id) ?? 0) > 0,
    });
  }

  // 5. Global chronological sort. Stable tiebreaker on id for deterministic
  //    output under identical timestamps (common for CC lifecycle pairs).
  rows.sort((a, b) => {
    const aRank = tsRank(a);
    const bRank = tsRank(b);
    if (aRank !== bRank) return aRank - bRank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return rows;
}

export type { SpanType };
