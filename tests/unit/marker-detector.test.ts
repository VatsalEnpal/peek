import { describe, test, expect } from 'vitest';
import { detectMarkers } from '../../server/bookmarks/marker-detector';
import type { Session } from '../../server/pipeline/model';

function makeSession(): Session {
  return {
    id: 'sess-1',
    turns: [],
    spans: [],
    ledger: [],
  };
}

describe('detectMarkers (Task 5.3)', () => {
  test('@peek-start creates a pending bookmark with label', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: { content: '@peek-start my work' },
      },
    ]);
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe('my work');
    expect(bms[0].source).toBe('marker');
    expect(bms[0].startTs).toBe('2026-04-19T00:00:00Z');
    expect(bms[0].endTs).toBeUndefined();
  });

  test('@peek-start + @peek-end creates a closed bookmark', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: { content: 'hello @peek-start investigate leak world' },
      },
      {
        type: 'user',
        timestamp: '2026-04-19T00:05:00Z',
        message: { content: 'done @peek-end' },
      },
    ]);
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe('investigate leak world');
    expect(bms[0].startTs).toBe('2026-04-19T00:00:00Z');
    expect(bms[0].endTs).toBe('2026-04-19T00:05:00Z');
  });

  test('orphan @peek-end is ignored', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: { content: '@peek-end alone' },
      },
    ]);
    expect(bms).toEqual([]);
  });

  test('nested @peek-start warns, keeps first label', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: { content: '@peek-start first' },
      },
      {
        type: 'user',
        timestamp: '2026-04-19T00:01:00Z',
        message: { content: '@peek-start second' },
      },
      {
        type: 'user',
        timestamp: '2026-04-19T00:02:00Z',
        message: { content: '@peek-end' },
      },
    ]);
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe('first');
    expect(bms[0].metadata?.warnings?.some((w) => w.includes('nested'))).toBe(true);
  });

  test('handles array-shaped content with text blocks', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: {
          content: [{ type: 'text', text: 'please @peek-start debugging' }],
        },
      },
    ]);
    expect(bms).toHaveLength(1);
    expect(bms[0].label).toBe('debugging');
  });

  test('unlabeled start uses default label', () => {
    const bms = detectMarkers(makeSession(), [
      {
        type: 'user',
        timestamp: '2026-04-19T00:00:00Z',
        message: { content: '@peek-start' },
      },
    ]);
    expect(bms[0].label).toBe('unlabeled');
  });
});
