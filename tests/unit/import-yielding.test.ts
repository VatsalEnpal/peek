/**
 * L5.1 — within-file yielding.
 *
 * persistSession must yield to the event loop every N events so a single
 * huge JSONL doesn't block incoming HTTP requests during a bulk import.
 *
 * Test strategy: feed persistSession a session with 150 spans (3x the yield
 * cadence). Kick off an external setImmediate task right before we await
 * persistSession. If the function yields, the external task lands BEFORE
 * the overall Promise resolves.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { persistSessionForTests, YIELD_EVERY } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';
import type { Session } from '../../server/pipeline/model';

function makeSession(spanCount: number): Session {
  return {
    id: 'sess-big',
    salt: 'salt',
    turns: [],
    spans: Array.from({ length: spanCount }, (_, i) => ({
      id: `span-${i}`,
      sessionId: 'sess-big',
      type: 'tool_call',
      name: 'Read',
      startTs: new Date(Date.UTC(2026, 3, 19, 10, 0, i % 60)).toISOString(),
      tokensConsumed: 1,
    })),
    ledger: [],
  } as unknown as Session;
}

describe('persistSession — within-file yielding (L5.1)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.putSession({ id: 'sess-big', salt: 'salt' });
  });

  afterEach(() => {
    store.close();
  });

  test('yields to the event loop at least once for 3× YIELD_EVERY spans', async () => {
    expect(YIELD_EVERY).toBeGreaterThan(0);
    const n = YIELD_EVERY * 3;
    const session = makeSession(n);

    let externalFires = 0;
    const schedule = (): void => {
      setImmediate(() => {
        externalFires++;
      });
    };
    schedule();

    await persistSessionForTests(store, session, 'salt');

    expect(externalFires).toBeGreaterThanOrEqual(1);
  });
});
