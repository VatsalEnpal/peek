/**
 * L2.4 — CONTEXT gauge compute function.
 *
 * Problem: cumulative token sum (e.g. 30M) vs a 200k ceiling is misleading —
 * it does not reflect context-window pressure, only session cost.
 *
 * Fix: compute the MAX token count of any single turn. That number, compared
 * to 200k, is the real "how close did we get to the context ceiling"
 * signal. Also surface cumulative + turn count as a secondary line.
 *
 * `computeContextGaugeStats` is pure, so we can exhaustively test it without
 * rendering any React.
 */

import { describe, expect, it } from 'vitest';

import { computeContextGaugeStats } from '../../src/lib/contextGauge';
import type { StoreEvent } from '../../src/stores/session';

/** Small helper to keep fixtures readable. */
function span(args: {
  id: string;
  turnId?: string;
  tokens?: number;
  type?: string;
}): StoreEvent {
  return {
    kind: 'span',
    id: args.id,
    sessionId: 'S',
    turnId: args.turnId,
    type: args.type ?? 'api_call',
    tokensConsumed: args.tokens,
  };
}

describe('computeContextGaugeStats', () => {
  it('returns zeros for an empty event list', () => {
    const out = computeContextGaugeStats([]);
    expect(out.maxPerTurn).toBe(0);
    expect(out.cumulative).toBe(0);
    expect(out.turnCount).toBe(0);
  });

  it('groups spans by turnId and picks the max turn sum', () => {
    // turn A: 10k + 20k = 30k
    // turn B: 50k + 40k = 90k  ← this is the max per-turn
    // turn C: 5k
    const events: StoreEvent[] = [
      span({ id: '1', turnId: 'A', tokens: 10_000 }),
      span({ id: '2', turnId: 'A', tokens: 20_000 }),
      span({ id: '3', turnId: 'B', tokens: 50_000 }),
      span({ id: '4', turnId: 'B', tokens: 40_000 }),
      span({ id: '5', turnId: 'C', tokens: 5_000 }),
    ];

    const out = computeContextGaugeStats(events);
    expect(out.maxPerTurn).toBe(90_000);
    expect(out.cumulative).toBe(125_000);
    expect(out.turnCount).toBe(3);
  });

  it('treats spans without turnId as their own single-span turn', () => {
    // When a span has no turnId we still want it counted exactly once.
    // Orphan spans should not be collapsed into one bucket — that would
    // artificially inflate maxPerTurn.
    const events: StoreEvent[] = [
      span({ id: '1', tokens: 3_000 }), // orphan A
      span({ id: '2', tokens: 4_000 }), // orphan B
      span({ id: '3', turnId: 'T', tokens: 7_000 }),
    ];

    const out = computeContextGaugeStats(events);
    // max-per-turn: max(3k, 4k, 7k) = 7k
    expect(out.maxPerTurn).toBe(7_000);
    expect(out.cumulative).toBe(14_000);
    // 2 orphan turns + 1 real turn
    expect(out.turnCount).toBe(3);
  });

  it('ignores ledger events (cumulative is span-driven only)', () => {
    const events: StoreEvent[] = [
      span({ id: '1', turnId: 'A', tokens: 100 }),
      {
        kind: 'ledger',
        id: 'L1',
        sessionId: 'S',
        turnId: 'A',
        tokens: 9_999, // should NOT be counted
      },
    ];
    const out = computeContextGaugeStats(events);
    expect(out.maxPerTurn).toBe(100);
    expect(out.cumulative).toBe(100);
    expect(out.turnCount).toBe(1);
  });

  it('falls back to `tokens` when `tokensConsumed` is missing', () => {
    const events: StoreEvent[] = [
      { kind: 'span', id: '1', sessionId: 'S', turnId: 'A', type: 'api_call', tokens: 42 },
    ];
    const out = computeContextGaugeStats(events);
    expect(out.maxPerTurn).toBe(42);
    expect(out.cumulative).toBe(42);
    expect(out.turnCount).toBe(1);
  });

  it('treats missing token fields as zero (does not NaN)', () => {
    const events: StoreEvent[] = [
      { kind: 'span', id: '1', sessionId: 'S', turnId: 'A', type: 'api_call' },
    ];
    const out = computeContextGaugeStats(events);
    expect(out.maxPerTurn).toBe(0);
    expect(out.cumulative).toBe(0);
    // Still one turn (A).
    expect(out.turnCount).toBe(1);
  });

  it('realistic case: max-per-turn is dramatically smaller than cumulative', () => {
    // This is the real-world regression described in the plan:
    //   cumulative = 30,614,665; max per turn ~ 159,806
    // We simulate 44 turns where each turn sums ~700k (unrealistic, but the
    // property we care about is: max << cumulative).
    const events: StoreEvent[] = [];
    for (let i = 0; i < 44; i += 1) {
      events.push(span({ id: `t${i}`, turnId: `turn-${i}`, tokens: 700_000 }));
    }
    // Bump one turn higher so it's clearly the max.
    events.push(span({ id: 'peak', turnId: 'turn-peak', tokens: 159_806 }));

    const out = computeContextGaugeStats(events);
    expect(out.maxPerTurn).toBe(700_000);
    expect(out.cumulative).toBe(44 * 700_000 + 159_806);
    expect(out.turnCount).toBe(45);
    // Key regression check: cumulative is much bigger than maxPerTurn.
    expect(out.cumulative).toBeGreaterThan(out.maxPerTurn * 10);
  });
});
