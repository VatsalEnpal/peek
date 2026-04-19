/**
 * L1.2 — marker regex strictness + idempotency.
 *
 * Enforces the v0.3 tightening:
 *  1. Prose containing @peek-end / @peek-start does NOT create bookmarks.
 *  2. Bookmark ids are derived from the source event's uuid so re-importing
 *     the same JSONL twice produces identical rows (INSERT OR REPLACE is a
 *     no-op instead of a duplicate).
 */

import { describe, expect, test } from 'vitest';

import { detectMarkers } from '../../server/bookmarks/marker-detector';
import type { Session } from '../../server/pipeline/model';

function makeSession(): Session {
  return { id: 'sess-1', turns: [], spans: [], ledger: [] };
}

describe('detectMarkers — strict (v0.3)', () => {
  test('does NOT match prose containing @peek-end', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        uuid: 'evt-a',
        message: { content: 'the @peek-end marker is useful in docs' },
      },
    ]);
    expect(bms).toEqual([]);
  });

  test('does NOT match prose containing @peek-start', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        uuid: 'evt-b',
        message: { content: 'hello @peek-start investigate leak world' },
      },
    ]);
    expect(bms).toEqual([]);
  });

  test('does NOT match SKILL body content that begins with "# /peek_start"', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        uuid: 'evt-c',
        message: { content: '# /peek_start — Open a Peek bookmark range\n\nSome docs' },
      },
    ]);
    expect(bms).toEqual([]);
  });

  test('DOES match a clean slash command user prompt', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        uuid: 'evt-d',
        message: { content: '/peek_start my-test' },
      },
      {
        type: 'user',
        timestamp: '2026-04-19T00:01:00Z',
        uuid: 'evt-e',
        message: { content: '/peek_end' },
      },
    ]);
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe('my-test');
    expect(bms[0].endTs).toBe('2026-04-19T00:01:00Z');
  });
});

describe('detectMarkers — idempotency (v0.3)', () => {
  const raw = [
    {
      type: 'user',
      timestamp: '2026-04-19T00:00:00Z',
      uuid: 'evt-start-1',
      message: { content: '/peek_start foo' },
    },
    {
      type: 'user',
      timestamp: '2026-04-19T00:05:00Z',
      uuid: 'evt-end-1',
      message: { content: '/peek_end' },
    },
  ];

  test('bookmark id is derived from the starting event uuid (deterministic)', () => {
    const first = detectMarkers(makeSession(), raw);
    const second = detectMarkers(makeSession(), raw);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toContain('evt-start-1');
  });
});
