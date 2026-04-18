/**
 * Integration test: @peek-start/@peek-end markers are detected during
 * importPath and persisted as bookmarks on the Store.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importPath } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';

function makeMarkerJsonl(): string {
  const events = [
    {
      type: 'user',
      uuid: 'u-1',
      sessionId: 'marker-session-1',
      cwd: '/tmp/marker',
      gitBranch: 'main',
      version: '1.0.0',
      entrypoint: 'cli',
      timestamp: '2026-04-18T10:00:00Z',
      message: { role: 'user', content: '@peek-start repro-path' },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      parentUuid: 'u-1',
      sessionId: 'marker-session-1',
      timestamp: '2026-04-18T10:00:01Z',
      message: {
        role: 'assistant',
        id: 'msg-001',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'working on it' }],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'user',
      uuid: 'u-2',
      parentUuid: 'a-1',
      sessionId: 'marker-session-1',
      timestamp: '2026-04-18T10:00:05Z',
      message: { role: 'user', content: 'more detail here' },
    },
    {
      type: 'user',
      uuid: 'u-3',
      parentUuid: 'u-2',
      sessionId: 'marker-session-1',
      timestamp: '2026-04-18T10:00:10Z',
      message: { role: 'user', content: '@peek-end wrap it up' },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('importPath marker wiring', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-marker-src-'));
    dataDir = mkdtempSync(join(tmpdir(), 'peek-marker-data-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('@peek-start/@peek-end in jsonl produce a persisted marker bookmark', async () => {
    const file = join(tmpDir, 'marker.jsonl');
    writeFileSync(file, makeMarkerJsonl());

    await importPath(file, { dataDir });

    const store = new Store(dataDir);
    try {
      const bookmarks = store.listBookmarks('marker-session-1');
      expect(bookmarks.length).toBeGreaterThan(0);
      const marker = bookmarks.find((b) => b.source === 'marker');
      expect(marker, 'at least one marker bookmark').toBeDefined();
      expect(marker!.label).toBe('repro-path');
      expect(marker!.startTs).toBe('2026-04-18T10:00:00Z');
      expect(marker!.endTs).toBe('2026-04-18T10:00:10Z');
    } finally {
      store.close();
    }
  });

  test('jsonl without markers persists no marker bookmarks', async () => {
    const file = join(tmpDir, 'plain.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: 'u-0',
        sessionId: 'no-marker-session',
        cwd: '/tmp',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-18T11:00:00Z',
        message: { role: 'user', content: 'nothing fancy here' },
      }) + '\n'
    );

    await importPath(file, { dataDir });

    const store = new Store(dataDir);
    try {
      const bookmarks = store.listBookmarks('no-marker-session');
      expect(bookmarks.filter((b) => b.source === 'marker').length).toBe(0);
    } finally {
      store.close();
    }
  });
});
