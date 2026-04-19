/**
 * Unit tests for Recording entity on the SQLite Store.
 *
 * L1.1 — Recording table + store methods.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store, type RecordingRow, type SessionRow } from '../../server/pipeline/store';

describe('Store — recordings', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const makeSession = (id = 'sess-A'): SessionRow => ({
    id,
    salt: 'salt-' + id,
    startTs: '2026-04-19T10:00:00.000Z',
  });

  const makeRecording = (overrides: Partial<RecordingRow> = {}): RecordingRow => ({
    id: 'rec-1',
    name: 'refactoring-task',
    sessionId: 'sess-A',
    startTs: '2026-04-19T10:00:00.000Z',
    status: 'recording',
    createdAt: '2026-04-19T10:00:00.000Z',
    ...overrides,
  });

  it('round-trips a recording via putRecording + getRecording', () => {
    store.putSession(makeSession());
    const r = makeRecording();
    store.putRecording(r);

    const got = store.getRecording('rec-1');
    expect(got).not.toBeNull();
    expect(got).toEqual(r);
  });

  it('returns null for unknown recording id', () => {
    expect(store.getRecording('nope')).toBeNull();
  });

  it('listRecordings returns all recordings ordered by startTs desc', () => {
    store.putSession(makeSession('sess-A'));
    store.putSession(makeSession('sess-B'));
    store.putRecording(
      makeRecording({ id: 'r1', startTs: '2026-04-19T09:00:00.000Z' })
    );
    store.putRecording(
      makeRecording({ id: 'r2', startTs: '2026-04-19T11:00:00.000Z' })
    );
    store.putRecording(
      makeRecording({ id: 'r3', startTs: '2026-04-19T10:00:00.000Z', sessionId: 'sess-B' })
    );

    const list = store.listRecordings();
    expect(list.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('listOpenRecordingsBySession returns only open (status=recording) rows for that session', () => {
    store.putSession(makeSession('sess-A'));
    store.putSession(makeSession('sess-B'));
    store.putRecording(makeRecording({ id: 'r1', sessionId: 'sess-A', status: 'recording' }));
    store.putRecording(
      makeRecording({
        id: 'r2',
        sessionId: 'sess-A',
        status: 'closed',
        endTs: '2026-04-19T10:05:00.000Z',
      })
    );
    store.putRecording(makeRecording({ id: 'r3', sessionId: 'sess-B', status: 'recording' }));

    const openA = store.listOpenRecordingsBySession('sess-A');
    expect(openA.map((r) => r.id)).toEqual(['r1']);
    const openB = store.listOpenRecordingsBySession('sess-B');
    expect(openB.map((r) => r.id)).toEqual(['r3']);
  });

  it('closeRecording updates endTs and status', () => {
    store.putSession(makeSession());
    store.putRecording(makeRecording({ id: 'r1' }));

    store.closeRecording('r1', '2026-04-19T10:05:00.000Z', 'closed');

    const got = store.getRecording('r1');
    expect(got?.status).toBe('closed');
    expect(got?.endTs).toBe('2026-04-19T10:05:00.000Z');
  });

  it('closeRecording accepts auto-closed and auto-closed-by-new-start reasons', () => {
    store.putSession(makeSession());
    store.putRecording(makeRecording({ id: 'r1' }));
    store.putRecording(makeRecording({ id: 'r2' }));

    store.closeRecording('r1', '2026-04-19T10:05:00.000Z', 'auto-closed-by-new-start');
    store.closeRecording('r2', '2026-04-19T10:10:00.000Z', 'auto-closed');

    expect(store.getRecording('r1')?.status).toBe('auto-closed-by-new-start');
    expect(store.getRecording('r2')?.status).toBe('auto-closed');
  });

  it('putRecording upserts (INSERT OR REPLACE semantics)', () => {
    store.putSession(makeSession());
    store.putRecording(makeRecording({ id: 'r1', name: 'first-name' }));
    store.putRecording(makeRecording({ id: 'r1', name: 'updated-name' }));

    expect(store.getRecording('r1')?.name).toBe('updated-name');
    expect(store.listRecordings()).toHaveLength(1);
  });

  it('enforces foreign key to sessions (no session → insert throws)', () => {
    expect(() => store.putRecording(makeRecording({ sessionId: 'does-not-exist' }))).toThrow();
  });
});
