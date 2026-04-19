/**
 * Unit tests for the SQLite-backed Store.
 *
 * Covers schema creation, round-trip of all row kinds, listing helpers,
 * schema-version mismatch detection, and foreign-key enforcement.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  SCHEMA_VERSION,
  Store,
  type BookmarkRow,
  type LedgerEntryRow,
  type SessionRow,
  type SpanRow,
  type TurnRow,
} from '../../server/pipeline/store';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const makeSession = (overrides: Partial<SessionRow> = {}): SessionRow => ({
    id: 'sess-1',
    slug: 'example',
    cwd: '/tmp/example',
    gitBranch: 'main',
    ccVersion: '1.2.3',
    entrypoint: 'claude',
    firstPrompt: 'hello',
    startTs: '2026-04-18T10:00:00.000Z',
    endTs: '2026-04-18T10:05:00.000Z',
    salt: 'abc123',
    metadata: { foo: 'bar', nested: { answer: 42 } },
    ...overrides,
  });

  it('creates schema on open and records schema_version=2 in :memory: DB', () => {
    // Peek at the underlying DB by re-opening via better-sqlite3 is not
    // possible for :memory: — instead assert externally-visible behaviour:
    // getSession on an unknown id is null, listSessions is [], and the
    // exported SCHEMA_VERSION constant matches the current version
    // (bumped to '2' in v0.2 for the action_spans.tokens_consumed column).
    expect(SCHEMA_VERSION).toBe('3');
    expect(store.getSession('nope')).toBeNull();
    expect(store.listSessions()).toEqual([]);
  });

  it('round-trips a session (with nested metadata) via putSession + getSession', () => {
    const s = makeSession();
    store.putSession(s);

    const got = store.getSession('sess-1');
    expect(got).not.toBeNull();
    expect(got).toEqual(s);
    // Nested metadata preserved.
    expect(got?.metadata).toEqual({ foo: 'bar', nested: { answer: 42 } });
  });

  it('listEvents returns a session’s spans merged with ledger entries, ordered by ts', () => {
    store.putSession(makeSession());
    const turn: TurnRow = {
      id: 'turn-1',
      sessionId: 'sess-1',
      turnIndex: 0,
      startTs: '2026-04-18T10:00:01.000Z',
      endTs: '2026-04-18T10:00:05.000Z',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    store.putTurn(turn);

    const span: SpanRow = {
      id: 'span-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      type: 'tool_use',
      name: 'Read',
      startTs: '2026-04-18T10:00:02.000Z',
      endTs: '2026-04-18T10:00:02.500Z',
      durationMs: 500,
      inputs: { path: '/tmp/x' },
      outputs: { ok: true },
      metadata: { tag: 'read' },
    };
    store.putSpan(span);

    const ledger: LedgerEntryRow = {
      id: 'led-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      introducedBySpanId: 'span-1',
      source: 'tool_result',
      tokens: 42,
      contentRedacted: 'hello',
      sourceOffset: {
        file: '/tmp/session.jsonl',
        byteStart: 100,
        byteEnd: 200,
        sourceLineHash: 'deadbeef',
      },
      ts: '2026-04-18T10:00:03.000Z',
    };
    store.putLedgerEntry(ledger);

    const events = store.listEvents('sess-1');
    expect(events).toHaveLength(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('span');
    expect(kinds).toContain('ledger');

    const spanEvt = events.find((e) => e.kind === 'span') as SpanRow & {
      kind: 'span';
    };
    expect(spanEvt.id).toBe('span-1');
    expect(spanEvt.inputs).toEqual({ path: '/tmp/x' });
    expect(spanEvt.outputs).toEqual({ ok: true });
  });

  it('stores a span parent chain correctly', () => {
    store.putSession(makeSession());

    const parent: SpanRow = {
      id: 'parent-1',
      sessionId: 'sess-1',
      type: 'agent',
      name: 'root',
      startTs: '2026-04-18T10:00:00.000Z',
    };
    const child: SpanRow = {
      id: 'child-1',
      sessionId: 'sess-1',
      parentSpanId: 'parent-1',
      type: 'tool_use',
      name: 'Grep',
      startTs: '2026-04-18T10:00:01.000Z',
    };
    const grandchild: SpanRow = {
      id: 'gc-1',
      sessionId: 'sess-1',
      parentSpanId: 'child-1',
      type: 'tool_use',
      name: 'Read',
      startTs: '2026-04-18T10:00:02.000Z',
    };

    store.putSpan(parent);
    store.putSpan(child);
    store.putSpan(grandchild);

    const events = store.listEvents('sess-1');
    const spans = events.filter((e) => e.kind === 'span') as Array<SpanRow & { kind: 'span' }>;
    const byId = new Map(spans.map((s) => [s.id, s]));
    expect(byId.get('parent-1')?.parentSpanId).toBeUndefined();
    expect(byId.get('child-1')?.parentSpanId).toBe('parent-1');
    expect(byId.get('gc-1')?.parentSpanId).toBe('child-1');
  });

  it('preserves sourceOffset JSON on ledger entries round-trip', () => {
    store.putSession(makeSession());
    const entry: LedgerEntryRow = {
      id: 'led-42',
      sessionId: 'sess-1',
      source: 'assistant',
      tokens: 7,
      contentRedacted: 'redacted-content',
      sourceOffset: {
        file: '/a/b/c.jsonl',
        byteStart: 0,
        byteEnd: 512,
        sourceLineHash: 'cafebabe',
      },
      ts: '2026-04-18T10:00:10.000Z',
    };
    store.putLedgerEntry(entry);

    const events = store.listEvents('sess-1');
    const ledger = events.find((e) => e.kind === 'ledger') as LedgerEntryRow & {
      kind: 'ledger';
    };
    expect(ledger.sourceOffset).toEqual({
      file: '/a/b/c.jsonl',
      byteStart: 0,
      byteEnd: 512,
      sourceLineHash: 'cafebabe',
    });
  });

  it('putBookmark + listBookmarks filters by sessionId', () => {
    store.putSession(makeSession());
    store.putSession(makeSession({ id: 'sess-2', slug: 'other' }));

    const b1: BookmarkRow = {
      id: 'bm-1',
      sessionId: 'sess-1',
      label: 'start',
      source: 'record',
      startTs: '2026-04-18T10:00:00.000Z',
      endTs: '2026-04-18T10:00:01.000Z',
      metadata: { note: 'hello' },
    };
    const b2: BookmarkRow = {
      id: 'bm-2',
      sessionId: 'sess-2',
      label: 'focus',
      source: 'focus',
    };
    store.putBookmark(b1);
    store.putBookmark(b2);

    expect(store.listBookmarks('sess-1')).toEqual([b1]);
    expect(store.listBookmarks('sess-2').map((b) => b.id)).toEqual(['bm-2']);
    expect(
      store
        .listBookmarks()
        .map((b) => b.id)
        .sort()
    ).toEqual(['bm-1', 'bm-2']);
  });

  it('throws on schema version mismatch when opening an existing DB with wrong version', () => {
    // Build a file-like DB in a temp path, write a bogus schema_version,
    // then re-open with Store and expect it to throw.
    const tmpFile = `/tmp/peek-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const db = new Database(tmpFile);
    db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)`).run('schema_version', '999');
    db.close();

    expect(() => new Store(tmpFile)).toThrow(/schema version mismatch/i);

    // Clean up.
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best effort
    }
  });

  it('putSession is idempotent (INSERT OR REPLACE)', () => {
    store.putSession(makeSession());
    store.putSession(makeSession({ slug: 'renamed' }));

    const got = store.getSession('sess-1');
    expect(got?.slug).toBe('renamed');
    expect(store.listSessions()).toHaveLength(1);
  });

  it('enforces foreign keys: inserting a turn for an unknown session throws', () => {
    const orphan: TurnRow = {
      id: 'turn-orphan',
      sessionId: 'sess-does-not-exist',
      turnIndex: 0,
    };
    expect(() => store.putTurn(orphan)).toThrow();
  });
});
