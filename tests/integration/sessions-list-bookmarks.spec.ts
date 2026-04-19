/**
 * Integration (L14): `GET /api/sessions` includes each session's bookmarks
 * so the sessions list card can surface `/peek_start` / `/peek_end` markers
 * inline without a second round-trip.
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

describe('GET /api/sessions — bookmarks surface on session cards (L14)', () => {
  test('each session summary includes its bookmarks array', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l14-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();

    const store = new Store(dataDir);
    try {
      store.putSession({
        id: 'sess-L14',
        salt: 's',
        startTs: '2026-04-19T10:00:00Z',
        firstPrompt: 'Research',
      });
      store.putBookmark({
        id: 'bm-1',
        sessionId: 'sess-L14',
        source: 'marker',
        label: 'Test_vatsal',
        startTs: '2026-04-19T10:05:00Z',
      });
      store.putBookmark({
        id: 'bm-2',
        sessionId: 'sess-L14',
        source: 'marker',
        label: 'second',
        startTs: '2026-04-19T10:10:00Z',
      });
    } finally {
      store.close();
    }

    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no addr');
    const res = await getJson(`http://127.0.0.1:${addr.port}/api/sessions`);

    const s = res.body.find((x: any) => x.id === 'sess-L14');
    expect(s).toBeDefined();
    expect(Array.isArray(s.bookmarks)).toBe(true);
    expect(s.bookmarks).toHaveLength(2);
    const labels = s.bookmarks.map((b: any) => b.label);
    expect(labels).toContain('Test_vatsal');
    expect(labels).toContain('second');

    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('bookmarks array is empty when session has none', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-l14-empty-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();

    const store = new Store(dataDir);
    try {
      store.putSession({
        id: 'no-bms',
        salt: 's',
        startTs: '2026-04-19T10:00:00Z',
      });
    } finally {
      store.close();
    }

    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no addr');
    const res = await getJson(`http://127.0.0.1:${addr.port}/api/sessions`);
    const s = res.body.find((x: any) => x.id === 'no-bms');
    expect(s).toBeDefined();
    expect(Array.isArray(s.bookmarks)).toBe(true);
    expect(s.bookmarks).toHaveLength(0);

    await handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
