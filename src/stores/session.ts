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
 * Build a display list — respects filters + expand state. Ledger entries are
 * dropped from the flat timeline (they surface in the inspector); the user
 * cares about spans at this level.
 */
export function buildTimelineRows(
  events: StoreEvent[],
  active: Set<ChipKey>,
  expanded: Set<string>
): Array<SpanEvent & { depth: number; hasChildren: boolean }> {
  const spans = events.filter((e): e is SpanEvent => e.kind === 'span');
  const byParent = new Map<string | undefined, SpanEvent[]>();
  for (const s of spans) {
    const key = s.parentSpanId ?? undefined;
    const arr = byParent.get(key) ?? [];
    arr.push(s);
    byParent.set(key, arr);
  }

  const out: Array<SpanEvent & { depth: number; hasChildren: boolean }> = [];
  const walk = (span: SpanEvent, depth: number): void => {
    if (!spanVisible(span.type, active)) return;
    const children = byParent.get(span.id) ?? [];
    out.push({ ...span, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && expanded.has(span.id)) {
      for (const c of children) walk(c, depth + 1);
    }
  };
  for (const root of byParent.get(undefined) ?? []) walk(root, 0);
  return out;
}

export type { SpanType };
