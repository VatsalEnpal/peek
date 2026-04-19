/**
 * L1.5 — runtime token reconciliation wiring.
 *
 * The pure `reconcileSubagentTokens` primitive has its own unit coverage in
 * self-check.test.ts. This spec covers the *per-turn* wiring: once a Session
 * is assembled, we sum every span's `tokensConsumed` grouped by `turnId` and
 * compare it to `turn.usage` totals, with a 5% drift threshold per the v0.2
 * builder plan (line 177).
 *
 * The wiring lives on `reconcileTurnTokens(session, threshold?)` — it mutates
 * each `Turn` in place by setting `turn.reconciliation` and returns a flat
 * array of per-turn results so callers (import orchestrator, HTTP layer) can
 * decide whether to log / warn.
 */

import { describe, test, expect, vi } from 'vitest';
import { reconcileTurnTokens } from '../../server/pipeline/self-check';
import type { Session } from '../../server/pipeline/model';

function makeSession(opts: {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  childTokens: number[];
  turnId?: string;
}): Session {
  const turnId = opts.turnId ?? 'turn-0';
  return {
    id: 'sess-test',
    turns: [
      {
        id: turnId,
        index: 0,
        usage: {
          inputTokens: opts.usage.inputTokens,
          outputTokens: opts.usage.outputTokens,
          cacheCreationTokens: opts.usage.cacheCreationTokens ?? 0,
          cacheReadTokens: opts.usage.cacheReadTokens ?? 0,
        },
      },
    ],
    spans: opts.childTokens.map((t, i) => ({
      id: `span-${i}`,
      type: 'api_call' as const,
      turnId,
      childSpanIds: [],
      tokensConsumed: t,
    })),
    ledger: [],
  };
}

describe('reconcileTurnTokens (per-turn wiring, 5% threshold)', () => {
  test('exact match → reconciliation.match=true, drift=0', () => {
    const session = makeSession({
      usage: { inputTokens: 600, outputTokens: 400 },
      childTokens: [500, 500],
    });

    const results = reconcileTurnTokens(session, 0.05);

    expect(results.length).toBe(1);
    expect(results[0].match).toBe(true);
    expect(results[0].drift).toBe(0);
    expect(results[0].parentReported).toBe(1000);
    expect(results[0].childSum).toBe(1000);
    expect(results[0].threshold).toBe(0.05);
    // Session mutation: Turn.reconciliation populated.
    expect(session.turns[0].reconciliation).toBeDefined();
    expect(session.turns[0].reconciliation?.match).toBe(true);
    expect(session.turns[0].reconciliation?.drift).toBe(0);
  });

  test('3% drift (within 5% threshold) → match=true', () => {
    // parent=1000, childSum=1030 → drift=0.03
    const session = makeSession({
      usage: { inputTokens: 600, outputTokens: 400 },
      childTokens: [515, 515],
    });

    const results = reconcileTurnTokens(session, 0.05);

    expect(results[0].match).toBe(true);
    expect(results[0].drift).toBeCloseTo(0.03, 6);
    expect(results[0].parentReported).toBe(1000);
    expect(results[0].childSum).toBe(1030);
    expect(session.turns[0].reconciliation?.match).toBe(true);
  });

  test('10% drift (exceeds 5% threshold) → match=false, warning logged', () => {
    // parent=1000, childSum=1100 → drift=0.10
    const session = makeSession({
      usage: { inputTokens: 600, outputTokens: 400 },
      childTokens: [550, 550],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = reconcileTurnTokens(session, 0.05);

      expect(results[0].match).toBe(false);
      expect(results[0].drift).toBeCloseTo(0.1, 6);
      expect(results[0].parentReported).toBe(1000);
      expect(results[0].childSum).toBe(1100);
      // Warning actually emitted.
      expect(warnSpy).toHaveBeenCalled();
      const joined = warnSpy.mock.calls.map((c) => String(c[0])).join(' ');
      expect(joined.toLowerCase()).toContain('drift');
      // Per-turn reconciliation recorded on the Turn.
      expect(session.turns[0].reconciliation?.match).toBe(false);
      expect(session.turns[0].reconciliation?.threshold).toBe(0.05);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('empty turn (0 tokens on both sides) → match=true, drift=0', () => {
    const session = makeSession({
      usage: { inputTokens: 0, outputTokens: 0 },
      childTokens: [],
    });

    const results = reconcileTurnTokens(session, 0.05);

    expect(results[0].match).toBe(true);
    expect(results[0].drift).toBe(0);
    expect(results[0].parentReported).toBe(0);
    expect(results[0].childSum).toBe(0);
    expect(session.turns[0].reconciliation?.match).toBe(true);
  });

  test('skips turns without usage (no reconciliation recorded)', () => {
    const session: Session = {
      id: 'sess-no-usage',
      turns: [{ id: 'turn-x', index: 0 }], // no usage
      spans: [],
      ledger: [],
    };

    const results = reconcileTurnTokens(session, 0.05);

    expect(results.length).toBe(0);
    expect(session.turns[0].reconciliation).toBeUndefined();
  });

  test('cache tokens are included in parentReported', () => {
    // cache_creation=400, cache_read=100, input=300, output=200 → total=1000
    const session = makeSession({
      usage: {
        inputTokens: 300,
        outputTokens: 200,
        cacheCreationTokens: 400,
        cacheReadTokens: 100,
      },
      childTokens: [500, 500],
    });

    const results = reconcileTurnTokens(session, 0.05);

    expect(results[0].parentReported).toBe(1000);
    expect(results[0].childSum).toBe(1000);
    expect(results[0].match).toBe(true);
  });

  test('aggregates only spans belonging to the turn (turnId match)', () => {
    const session: Session = {
      id: 'sess-multi',
      turns: [
        {
          id: 't1',
          index: 0,
          usage: {
            inputTokens: 500,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
        {
          id: 't2',
          index: 1,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      ],
      spans: [
        { id: 's1', type: 'api_call', turnId: 't1', childSpanIds: [], tokensConsumed: 1000 },
        { id: 's2', type: 'api_call', turnId: 't2', childSpanIds: [], tokensConsumed: 200 },
        { id: 's3', type: 'unknown', turnId: undefined, childSpanIds: [], tokensConsumed: 9999 },
      ],
      ledger: [],
    };

    const results = reconcileTurnTokens(session, 0.05);

    expect(results.length).toBe(2);
    const r1 = results.find((r) => r.turnId === 't1')!;
    const r2 = results.find((r) => r.turnId === 't2')!;
    expect(r1.parentReported).toBe(1000);
    expect(r1.childSum).toBe(1000);
    expect(r1.match).toBe(true);
    expect(r2.parentReported).toBe(200);
    expect(r2.childSum).toBe(200);
    expect(r2.match).toBe(true);
  });
});
