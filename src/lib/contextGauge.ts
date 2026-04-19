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
 * ---------------------------------------------------------------------------
 * L2.4 CRITICAL — SOURCE OF TRUTH FOR `maxPerTurn`
 *
 * The gauge now reports REAL per-turn model usage from the JSONL `usage`
 * field — the same number Claude Code's `/usage` command displays — NOT
 * the sum of per-span content tokens.
 *
 * Why: spans only carry per-tool content tokens (the string "ls -la"
 * ≈ 5 tokens). The actual per-turn cost — system prompt + cached context
 * + history + assistant reply — is NEVER attributed to spans. Summing
 * span.tokensConsumed per turn under-reports real context-window pressure
 * by ~40x on real Claude Code sessions (seen: 17,920 gauge value vs actual
 * 738,732 — the reconciler's `parentReported` in self-check.ts).
 *
 * When `turn` events with `usage` are present on the wire, this function
 * uses those directly. When they're absent (legacy imports), it falls back
 * to summing span.tokensConsumed per turnId — imprecise, but non-zero.
 *
 * Ledger events are ignored — they are derived / de-duplicated downstream and
 * their tokens are already attributed to the spans that introduced them.
 * ---------------------------------------------------------------------------
 */

import type { StoreEvent } from '../stores/session';

export type ContextGaugeStats = {
  maxPerTurn: number;
  cumulative: number;
  turnCount: number;
};

/**
 * Fold over the event list.
 *
 * Priority for `maxPerTurn`:
 *   1. If any `turn` event carries a `usage` object → use
 *      `inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens`
 *      per turn. This matches the reconciler's `parentReported` and what
 *      Claude Code's `/usage` reports.
 *   2. Otherwise (no turn events emitted by the server) fall back to the
 *      legacy behavior: sum `span.tokensConsumed` per turnId.
 *
 * Orphan spans (no turnId): each treated as its own bucket (keyed by a
 * synthetic `__orphan:<spanId>` string) so one outlier cannot inflate any
 * real turn's total.
 *
 * Tokens source of truth for span fallback:
 *   1. `tokensConsumed` (canonical, set by the pipeline)
 *   2. `tokens` (legacy alias emitted by older builders)
 *   3. `0` otherwise
 */
export function computeContextGaugeStats(events: ReadonlyArray<StoreEvent>): ContextGaugeStats {
  // -----------------------------------------------------------------------
  // Pass 1: gather turn.usage totals (the real per-turn numbers).
  // -----------------------------------------------------------------------
  const usageByTurn = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'turn') continue;
    if (!e.usage) continue;
    const u = e.usage;
    const total =
      (Number(u.inputTokens) || 0) +
      (Number(u.outputTokens) || 0) +
      (Number(u.cacheCreationTokens) || 0) +
      (Number(u.cacheReadTokens) || 0);
    usageByTurn.set(e.id, total);
  }

  // -----------------------------------------------------------------------
  // Pass 2: gather span totals bucketed by turnId (used either for cumulative
  // alongside turn.usage, or as the full fallback when no turn events are
  // present).
  // -----------------------------------------------------------------------
  const spanTokensByTurn = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'span') continue;
    const tok = typeof e.tokensConsumed === 'number' ? e.tokensConsumed : (e.tokens ?? 0);
    const key = e.turnId && e.turnId.length > 0 ? e.turnId : `__orphan:${e.id}`;
    spanTokensByTurn.set(key, (spanTokensByTurn.get(key) ?? 0) + tok);
  }

  // -----------------------------------------------------------------------
  // Decide which source drives `maxPerTurn` + `turnCount`.
  // -----------------------------------------------------------------------
  const hasTurnUsage = usageByTurn.size > 0;

  let maxPerTurn = 0;
  let turnCount = 0;

  if (hasTurnUsage) {
    for (const v of usageByTurn.values()) {
      if (v > maxPerTurn) maxPerTurn = v;
    }
    turnCount = usageByTurn.size;
  } else {
    for (const v of spanTokensByTurn.values()) {
      if (v > maxPerTurn) maxPerTurn = v;
    }
    turnCount = spanTokensByTurn.size;
  }

  // Cumulative is span-driven regardless — it's a session-cost number
  // (what the user spent on tool content), distinct from per-turn pressure.
  let cumulative = 0;
  for (const v of spanTokensByTurn.values()) {
    cumulative += v;
  }

  return {
    maxPerTurn,
    cumulative,
    turnCount,
  };
}
