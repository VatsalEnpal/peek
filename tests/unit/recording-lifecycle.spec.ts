/**
 * L1.3 + L1.4 — Marker → Recording lifecycle.
 *
 * Unit-tests the pure `processMarker(store, input, now?)` helper that backs
 * the `POST /api/markers` route. Keeping the logic in a helper means the
 * lifecycle is exercised without spinning up Express/HTTP.
 *
 * Covered cases (plan L1.4):
 *  - start + end → one 'closed' recording
 *  - start twice in same session → first flips to 'auto-closed-by-new-start',
 *    second stays 'recording'
 *  - timeout helper autoCloseStaleRecordings → 'auto-closed'
 *  - idempotency: same requestId twice → one recording
 *  - two sessions isolate open recordings
 *  - orphan /peek_end → no crash, no recording row created
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { autoCloseStaleRecordings, processMarker } from '../../server/api/marker-lifecycle';
import { Store } from '../../server/pipeline/store';

describe('processMarker — recording lifecycle', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.putSession({ id: 'sess-A', salt: 's', startTs: '2026-04-19T10:00:00.000Z' });
    store.putSession({ id: 'sess-B', salt: 's', startTs: '2026-04-19T10:00:00.000Z' });
  });

  afterEach(() => {
    store.close();
  });

  test('start + end → one closed recording', () => {
    const startRes = processMarker(store, {
      type: 'start',
      name: 'refactor',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-start-1',
    });
    expect(startRes.recording?.status).toBe('recording');
    expect(startRes.recording?.name).toBe('refactor');

    const endRes = processMarker(store, {
      type: 'end',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:05:00.000Z',
      requestId: 'req-end-1',
    });
    expect(endRes.recording?.status).toBe('closed');
    expect(endRes.recording?.endTs).toBe('2026-04-19T10:05:00.000Z');

    const list = store.listRecordings();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('closed');
  });

  test('start twice in one session → first auto-closed-by-new-start, second open', () => {
    processMarker(store, {
      type: 'start',
      name: 'first',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-1',
    });
    processMarker(store, {
      type: 'start',
      name: 'second',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:01:00.000Z',
      requestId: 'req-2',
    });

    const all = store.listRecordings();
    expect(all).toHaveLength(2);
    const first = all.find((r) => r.name === 'first');
    const second = all.find((r) => r.name === 'second');
    expect(first?.status).toBe('auto-closed-by-new-start');
    expect(first?.endTs).toBe('2026-04-19T10:01:00.000Z');
    expect(second?.status).toBe('recording');
    expect(second?.endTs).toBeUndefined();
  });

  test('autoCloseStaleRecordings closes when lastEventTs is > 10min old', () => {
    processMarker(store, {
      type: 'start',
      name: 'idle',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-idle',
    });

    // 11 minutes later with no further events from sess-A.
    autoCloseStaleRecordings(store, {
      now: '2026-04-19T10:11:00.000Z',
      lastEventTsBySession: { 'sess-A': '2026-04-19T10:00:30.000Z' },
      idleMs: 10 * 60 * 1000,
    });

    const [r] = store.listRecordings();
    expect(r.status).toBe('auto-closed');
    expect(r.endTs).toBe('2026-04-19T10:00:30.000Z');
  });

  test('autoCloseStaleRecordings does NOT close when activity is recent', () => {
    processMarker(store, {
      type: 'start',
      name: 'live',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-live',
    });
    autoCloseStaleRecordings(store, {
      now: '2026-04-19T10:05:00.000Z',
      lastEventTsBySession: { 'sess-A': '2026-04-19T10:04:30.000Z' },
      idleMs: 10 * 60 * 1000,
    });

    const [r] = store.listRecordings();
    expect(r.status).toBe('recording');
  });

  test('idempotency: same requestId twice produces one recording', () => {
    const payload = {
      type: 'start' as const,
      name: 'once',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-dedup',
    };
    const r1 = processMarker(store, payload);
    const r2 = processMarker(store, payload);

    expect(r1.recording?.id).toBe(r2.recording?.id);
    expect(store.listRecordings()).toHaveLength(1);
  });

  test('two sessions: open recording in A does not interfere with B', () => {
    processMarker(store, {
      type: 'start',
      name: 'a-work',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'reqA',
    });
    processMarker(store, {
      type: 'start',
      name: 'b-work',
      sessionId: 'sess-B',
      timestamp: '2026-04-19T10:00:30.000Z',
      requestId: 'reqB',
    });

    const openA = store.listOpenRecordingsBySession('sess-A');
    const openB = store.listOpenRecordingsBySession('sess-B');
    expect(openA).toHaveLength(1);
    expect(openA[0].name).toBe('a-work');
    expect(openB).toHaveLength(1);
    expect(openB[0].name).toBe('b-work');
  });

  test('/peek_end with no open recording → orphan flag, no row created', () => {
    const res = processMarker(store, {
      type: 'end',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'orphan-end',
    });
    expect(res.orphan).toBe(true);
    expect(res.recording).toBeUndefined();
    expect(store.listRecordings()).toHaveLength(0);
  });

  test('starting a recording broadcasts recording:started', () => {
    const events: Array<{ event: string; data: unknown }> = [];
    processMarker(
      store,
      {
        type: 'start',
        name: 'watch-me',
        sessionId: 'sess-A',
        timestamp: '2026-04-19T10:00:00.000Z',
        requestId: 'req-sse',
      },
      { broadcast: (event, data) => events.push({ event, data }) }
    );
    expect(events.some((e) => e.event === 'recording:started')).toBe(true);
  });

  test('ending a recording broadcasts recording:ended', () => {
    processMarker(store, {
      type: 'start',
      name: 'track',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'req-sse-s',
    });
    const events: Array<{ event: string; data: unknown }> = [];
    processMarker(
      store,
      {
        type: 'end',
        sessionId: 'sess-A',
        timestamp: '2026-04-19T10:01:00.000Z',
        requestId: 'req-sse-e',
      },
      { broadcast: (event, data) => events.push({ event, data }) }
    );
    expect(events.some((e) => e.event === 'recording:ended')).toBe(true);
  });

  test('auto-closing due to new start broadcasts recording:ended first, then :started', () => {
    processMarker(store, {
      type: 'start',
      name: 'first',
      sessionId: 'sess-A',
      timestamp: '2026-04-19T10:00:00.000Z',
      requestId: 'r1',
    });
    const events: Array<{ event: string; data: unknown }> = [];
    processMarker(
      store,
      {
        type: 'start',
        name: 'second',
        sessionId: 'sess-A',
        timestamp: '2026-04-19T10:01:00.000Z',
        requestId: 'r2',
      },
      { broadcast: (event, data) => events.push({ event, data }) }
    );
    const seq = events.map((e) => e.event);
    expect(seq.indexOf('recording:ended')).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf('recording:started')).toBeGreaterThan(seq.indexOf('recording:ended'));
  });
});
