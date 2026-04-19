/**
 * Integration: importer auto-registers slash-command markers.
 *
 * L1.3 secondary: when a `user_prompt` event's text matches the strict
 * marker regex (`/peek_start NAME`, `@peek-start NAME`, etc.), the importer
 * should persist a `source='marker'` bookmark — just as it does today for
 * the legacy `@peek-start` inline-in-prose syntax.
 *
 * We intentionally don't modify `import-markers.test.ts` — that protects
 * the v0.2.0 inline syntax. This new spec covers the v0.2.1 slash shape.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importPath } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';

describe('importer — slash-command markers (L1.3)', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-slash-marker-src-'));
    dataDir = mkdtempSync(join(tmpdir(), 'peek-slash-marker-data-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('/peek_start NAME and /peek_end produce a closed marker bookmark', async () => {
    const events = [
      {
        type: 'user',
        uuid: 'u-1',
        sessionId: 'slash-session-1',
        cwd: '/tmp/slash',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-19T14:00:00Z',
        message: { role: 'user', content: '/peek_start slash-work' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'slash-session-1',
        timestamp: '2026-04-19T14:00:01Z',
        message: {
          role: 'assistant',
          id: 'msg-001',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'user',
        uuid: 'u-2',
        parentUuid: 'a-1',
        sessionId: 'slash-session-1',
        timestamp: '2026-04-19T14:02:00Z',
        message: { role: 'user', content: '/peek_end' },
      },
    ];
    const file = join(tmpDir, 'slash.jsonl');
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    await importPath(file, { dataDir });

    const store = new Store(dataDir);
    try {
      const bookmarks = store.listBookmarks('slash-session-1');
      const marker = bookmarks.find((b) => b.source === 'marker' && b.label === 'slash-work');
      expect(marker, 'marker bookmark with label slash-work').toBeDefined();
      expect(marker!.startTs).toBe('2026-04-19T14:00:00Z');
      expect(marker!.endTs).toBe('2026-04-19T14:02:00Z');
    } finally {
      store.close();
    }
  });

  test('inline prose "/peek_start" inside a longer message does NOT match', async () => {
    // Anchored regex → prose mentions do not register. The message below
    // would have matched the legacy loose regex (if it had a `@peek-start`
    // sigil) but uses the slash sigil inline, which the strict detector
    // correctly rejects.
    const events = [
      {
        type: 'user',
        uuid: 'u-1',
        sessionId: 'prose-session',
        cwd: '/tmp/prose',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-19T15:00:00Z',
        message: {
          role: 'user',
          content: 'remember to run /peek_start later when ready',
        },
      },
    ];
    const file = join(tmpDir, 'prose.jsonl');
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    await importPath(file, { dataDir });

    const store = new Store(dataDir);
    try {
      const bookmarks = store.listBookmarks('prose-session');
      expect(bookmarks.filter((b) => b.source === 'marker').length).toBe(0);
    } finally {
      store.close();
    }
  });
});
