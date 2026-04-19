/**
 * L2.4 — Context-gauge statistics.
 *
 * `computeContextGaugeStats` is a pure reducer over the current session's
 * events. It produces three numbers:
 *
 *   - `maxPerTurn`  — the largest single-turn token total. This is the
 *                     number we compare against the 200 k context ceiling.
 *                     It answers "how close did we get to the wall?" — not
 *                     "how much did we spend across the whole session?".
 *   - `cumulative`  — total spans tokens across the session. Useful as a
 *                     secondary stat ("30M across 44 turns") but meaningless
 *                     against the 200 k ceiling.
 *   - `turnCount`   — number of distinct buckets, where a missing `turnId`
 *                     becomes its own synthetic single-span bucket so we
 *                     don't artificially inflate any one turn.
 *
 * Ledger events are ignored — they are derived / de-duplicated downstream and
 * their tokens are already attributed to the spans that introduced them.
 */

import type { StoreEvent } from '../stores/session';

export type ContextGaugeStats = {
  maxPerTurn: number;
  cumulative: number;
  turnCount: number;
};

/**
 * Fold over the event list, bucketing span token counts by `turnId`.
 *
 * Span without a `turnId`: treated as its own bucket (keyed by a synthetic
 * `__orphan:<spanId>` string). This keeps the per-turn max honest — one
 * missing-turnId outlier should not get lumped with everyone else.
 *
 * Tokens source of truth:
 *   1. `tokensConsumed` (canonical, set by the pipeline)
 *   2. `tokens` (legacy alias emitted by older builders)
 *   3. `0` otherwise
 */
export function computeContextGaugeStats(events: ReadonlyArray<StoreEvent>): ContextGaugeStats {
  const byTurn = new Map<string, number>();

  for (const e of events) {
    if (e.kind !== 'span') continue;
    const tok = typeof e.tokensConsumed === 'number' ? e.tokensConsumed : (e.tokens ?? 0);
    const key = e.turnId && e.turnId.length > 0 ? e.turnId : `__orphan:${e.id}`;
    byTurn.set(key, (byTurn.get(key) ?? 0) + tok);
  }

  let maxPerTurn = 0;
  let cumulative = 0;
  for (const v of byTurn.values()) {
    if (v > maxPerTurn) maxPerTurn = v;
    cumulative += v;
  }

  return {
    maxPerTurn,
    cumulative,
    turnCount: byTurn.size,
  };
}
