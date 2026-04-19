/**
 * Integration: POST /api/markers creates bookmark rows and broadcasts SSE.
 *
 * L1.3 of v0.2.1. Contract:
 *
 *   POST /api/markers { type: 'start', name: 'X', sessionId?, timestamp? }
 *     → 201 { id, type: 'start', label: 'X', sessionId, startTs }
 *     → persists a row into the bookmarks table (source='marker')
 *     → broadcasts `marker:opened` on the SSE channel
 *
 *   POST /api/markers { type: 'end', sessionId?, timestamp? }
 *     → 201 { id, type: 'end', ... }
 *     → closes the most recent open marker (sets endTs) for that session
 *     → broadcasts `marker:closed`
 *
 * `sessionId` defaults to the literal string "live" — meaning "whichever
 * session is currently being appended to". That unblocks the slash-command
 * flow where Claude Code has no easy way to tell Peek which session-id it
 * belongs to. A later group (L2) will resolve this via a live-session
 * heuristic; for L1 we persist the literal so the API is usable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';

type Ctx = { baseUrl: string; dataDir: string; close: () => Promise<void> };

async function startServer(): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-marker-api-'));
  const handle = createServer({ dataDir, port: 0 });
  // Seed a session so the bookmarks FK to sessions(id) is satisfied.
  const seed = new Store(dataDir);
  seed.putSession({ id: 'live', salt: 'seed-salt' });
  seed.close();
  const server = await handle.listen();
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir,
    close: async () => {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function openSseAndCollect(url: string, count: number, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`sse timeout; buf=${JSON.stringify(buf)}`));
      }, timeoutMs);
      res.on('data', (c) => {
        buf += c.toString('utf8');
        const frames = buf
          .split('\n\n')
          .slice(0, -1)
          .filter((p) => /^event: /m.test(p));
        if (frames.length >= count) {
          clearTimeout(timer);
          req.destroy();
          resolve(buf);
        }
      });
    });
    req.on('error', reject);
  });
}

describe('POST /api/markers (L1.3)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('type=start persists bookmark row with source=marker', async () => {
    const res = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'investigate-leak',
      sessionId: 'live',
      timestamp: '2026-04-19T12:00:00Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('start');
    expect(res.body.label).toBe('investigate-leak');
    expect(res.body.sessionId).toBe('live');
    expect(res.body.startTs).toBe('2026-04-19T12:00:00Z');

    const store = new Store(ctx.dataDir);
    try {
      const bookmarks = store.listBookmarks('live');
      const bm = bookmarks.find((b) => b.id === res.body.id);
      expect(bm).toBeDefined();
      expect(bm!.source).toBe('marker');
      expect(bm!.label).toBe('investigate-leak');
      expect(bm!.startTs).toBe('2026-04-19T12:00:00Z');
      expect(bm!.endTs).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('type=end closes the most recent open marker for that session', async () => {
    await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'closeme',
      sessionId: 'live',
      timestamp: '2026-04-19T12:00:00Z',
    });
    const endRes = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'end',
      sessionId: 'live',
      timestamp: '2026-04-19T12:01:00Z',
    });
    expect(endRes.status).toBe(201);
    expect(endRes.body.type).toBe('end');
    expect(endRes.body.endTs).toBe('2026-04-19T12:01:00Z');

    const store = new Store(ctx.dataDir);
    try {
      const bookmarks = store.listBookmarks('live');
      const closed = bookmarks.find((b) => b.label === 'closeme');
      expect(closed).toBeDefined();
      expect(closed!.startTs).toBe('2026-04-19T12:00:00Z');
      expect(closed!.endTs).toBe('2026-04-19T12:01:00Z');
    } finally {
      store.close();
    }
  });

  test('POST broadcasts marker:opened over SSE', async () => {
    const sseUrl = `${ctx.baseUrl}/api/events/stream`;
    // v0.3 L1.3: POST /api/markers now emits BOTH `recording:started` (from
    // the new Recording lifecycle) and `marker:opened` (the legacy bookmark
    // broadcast), in that order. Collect both frames so the marker:opened
    // assertion isn't truncated by the earlier recording:started frame.
    const sseP = openSseAndCollect(sseUrl, 2);
    // Tiny delay so the subscriber registers before we POST.
    await new Promise((r) => setTimeout(r, 50));
    const post = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'broadcast-check',
      sessionId: 'live',
    });
    expect(post.status).toBe(201);
    const buf = await sseP;
    expect(buf).toMatch(/event: marker:opened/);
    expect(buf).toMatch(/"label":"broadcast-check"/);
  });

  test('missing type returns 400', async () => {
    const res = await postJson(`${ctx.baseUrl}/api/markers`, { name: 'oops' });
    expect(res.status).toBe(400);
  });
});
