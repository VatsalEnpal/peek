/**
 * Integration (L13): `GET /api/sessions` totalTokens reads `turn.usage` —
 * the same source of truth the CONTEXT gauge uses — rather than summing
 * ledger rows.
 *
 * Context: ledger rows only capture per-content-block tokens (the string
 * "ls -la" ≈ 5 tokens). Real context-window pressure — system prompt +
 * cached context + history + assistant reply — lives on `Turn.usage` in
 * the JSONL. Summing ledger tokens under-reports by ~40x on real CC
 * sessions, which is why every session card currently shows "0 / 200,000".
 *
 * Fix: totalTokens = max over turns of
 *   inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
 * — the same formula as `computeContextGaugeStats` (client) and
 * `reconcileTurnTokens.parentReported` (server).
 *
 * Why max not sum: the session card's progress bar is rendered against a
 * 200 k context ceiling. Sum across turns would trivially exceed the
 * ceiling ("30M across 44 turns") and make the bar useless. Max-per-turn
 * answers "how close did we get to the wall?" which matches the user's
 * mental model.
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';

function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString('utf8')));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

describe('GET /api/sessions — totalTokens from turn.usage (L13)', () => {
  test('totalTokens is max-per-turn over turn.usage, not a ledger sum', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l13-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();

    // Seed a session with 2 turns and known usage. The ledger sum would be
    // TINY (just the tiny per-span content tokens), but turn.usage has real
    // numbers. The list must reflect the real numbers.
    const store = new Store(dataDir);
    try {
      store.putSession({
        id: 'sess-L13',
        salt: 's',
        startTs: '2026-04-19T10:00:00Z',
        firstPrompt: 'Research G-Brain',
      });
      store.putTurn({
        id: 'turn-0',
        sessionId: 'sess-L13',
        turnIndex: 0,
        startTs: '2026-04-19T10:00:00Z',
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationTokens: 50,
          cacheReadTokens: 1000,
        },
      });
      // Turn 1 has the higher total → it should drive maxPerTurn.
      store.putTurn({
        id: 'turn-1',
        sessionId: 'sess-L13',
        turnIndex: 1,
        startTs: '2026-04-19T10:01:00Z',
        usage: {
          inputTokens: 500,
          outputTokens: 400,
          cacheCreationTokens: 100,
          cacheReadTokens: 40000,
        },
      });
      // A handful of ledger entries with deliberately low tokens so we can
      // prove the response does NOT come from the ledger sum.
      store.putSpan({
        id: 'span-0',
        sessionId: 'sess-L13',
        turnId: 'turn-0',
        type: 'user_prompt',
        tokensConsumed: 5,
      });
      store.putLedgerEntry({
        id: 'ledger-0',
        sessionId: 'sess-L13',
        turnId: 'turn-0',
        source: 'user_prompt',
        tokens: 5,
      });
      store.putLedgerEntry({
        id: 'ledger-1',
        sessionId: 'sess-L13',
        turnId: 'turn-1',
        source: 'tool_result',
        tokens: 3,
      });
    } finally {
      store.close();
    }

    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no addr');
    const url = `http://127.0.0.1:${addr.port}/api/sessions`;
    const res = await getJson(url);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const s = res.body.find((x: any) => x.id === 'sess-L13');
    expect(s).toBeDefined();

    // Expected max per-turn = 500 + 400 + 100 + 40000 = 41000.
    const expectedMax = 500 + 400 + 100 + 40000;
    expect(s.totalTokens).toBe(expectedMax);
    // Sanity: NOT the ledger sum (which would be 8).
    expect(s.totalTokens).not.toBe(8);

    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('falls back to ledger sum when no turns have usage (legacy sessions)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l13-legacy-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();

    const store = new Store(dataDir);
    try {
      store.putSession({
        id: 'sess-legacy',
        salt: 's',
        startTs: '2026-04-19T09:00:00Z',
        firstPrompt: 'legacy',
      });
      store.putLedgerEntry({
        id: 'ledger-x',
        sessionId: 'sess-legacy',
        source: 'user_prompt',
        tokens: 42,
      });
    } finally {
      store.close();
    }

    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no addr');
    const res = await getJson(`http://127.0.0.1:${addr.port}/api/sessions`);
    const s = res.body.find((x: any) => x.id === 'sess-legacy');
    expect(s).toBeDefined();
    expect(s.totalTokens).toBe(42);

    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
