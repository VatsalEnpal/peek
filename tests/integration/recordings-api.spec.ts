/**
 * L2 — Recordings API integration tests.
 *
 *   GET  /api/recordings                — list, with computed counts + duration
 *   GET  /api/recordings/:id            — summary
 *   GET  /api/recordings/:id/events     — events bounded by start/end ts
 *                                         (?includeLifecycle=1 to show noise)
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';

type Ctx = { baseUrl: string; dataDir: string; close: () => Promise<void> };

async function startServer(): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-recordings-'));
  const handle = createServer({ dataDir, port: 0 });
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

function get(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http
      .get(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
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
      )
      .on('error', reject);
  });
}

describe('Recordings API (L2)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await startServer();
    const seed = new Store(ctx.dataDir);
    seed.putSession({ id: 'sess-A', salt: 'x', startTs: '2026-04-19T10:00:00.000Z' });
    seed.putSession({ id: 'sess-B', salt: 'x', startTs: '2026-04-19T10:00:00.000Z' });

    // Recording 1: closed, with 2 tool-use spans and 1 api span inside window.
    seed.putRecording({
      id: 'rec-1',
      name: 'refactor',
      sessionId: 'sess-A',
      startTs: '2026-04-19T10:00:00.000Z',
      endTs: '2026-04-19T10:05:00.000Z',
      status: 'closed',
      createdAt: '2026-04-19T10:00:00.000Z',
    });
    // spans inside window
    seed.putSpan({
      id: 'span-1',
      sessionId: 'sess-A',
      type: 'tool_use',
      name: 'Read',
      startTs: '2026-04-19T10:00:30.000Z',
      tokensConsumed: 100,
    });
    seed.putSpan({
      id: 'span-2',
      sessionId: 'sess-A',
      type: 'tool_use',
      name: 'Bash',
      startTs: '2026-04-19T10:01:00.000Z',
      tokensConsumed: 50,
    });
    seed.putSpan({
      id: 'span-3',
      sessionId: 'sess-A',
      type: 'api_call',
      name: 'opus',
      startTs: '2026-04-19T10:02:00.000Z',
      tokensConsumed: 3000,
    });
    // span OUTSIDE window — must not count
    seed.putSpan({
      id: 'span-outside',
      sessionId: 'sess-A',
      type: 'tool_use',
      name: 'Grep',
      startTs: '2026-04-19T10:10:00.000Z',
      tokensConsumed: 999,
    });
    // span in DIFFERENT session — must not count
    seed.putSpan({
      id: 'span-other-session',
      sessionId: 'sess-B',
      type: 'tool_use',
      name: 'Read',
      startTs: '2026-04-19T10:00:30.000Z',
      tokensConsumed: 777,
    });

    // Recording 2: still open.
    seed.putRecording({
      id: 'rec-2',
      name: 'live-work',
      sessionId: 'sess-B',
      startTs: '2026-04-19T11:00:00.000Z',
      status: 'recording',
      createdAt: '2026-04-19T11:00:00.000Z',
    });

    seed.close();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('GET /api/recordings lists all with counts + duration', async () => {
    const { status, body } = await get(`${ctx.baseUrl}/api/recordings`);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    // Open recordings pinned first, then by startTs desc.
    expect(body.map((r: any) => r.id)).toEqual(['rec-2', 'rec-1']);

    const rec1 = body.find((r: any) => r.id === 'rec-1');
    expect(rec1.name).toBe('refactor');
    expect(rec1.status).toBe('closed');
    expect(rec1.sessionId).toBe('sess-A');
    expect(rec1.startTs).toBe('2026-04-19T10:00:00.000Z');
    expect(rec1.endTs).toBe('2026-04-19T10:05:00.000Z');
    expect(rec1.durationMs).toBe(5 * 60 * 1000);
    expect(rec1.toolCount).toBe(2);
    expect(rec1.apiCount).toBe(1);
    expect(rec1.totalTokens).toBe(100 + 50 + 3000);

    const rec2 = body.find((r: any) => r.id === 'rec-2');
    expect(rec2.status).toBe('recording');
    expect(rec2.endTs).toBeNull();
    expect(rec2.durationMs).toBeNull();
    expect(rec2.toolCount).toBe(0);
  });

  test('GET /api/recordings/:id returns summary', async () => {
    const { status, body } = await get(`${ctx.baseUrl}/api/recordings/rec-1`);
    expect(status).toBe(200);
    expect(body.id).toBe('rec-1');
    expect(body.name).toBe('refactor');
    expect(body.toolCount).toBe(2);
    expect(body.apiCount).toBe(1);
  });

  test('GET /api/recordings/:id 404s on unknown id', async () => {
    const { status } = await get(`${ctx.baseUrl}/api/recordings/does-not-exist`);
    expect(status).toBe(404);
  });

  test('GET /api/recordings/:id/events returns only in-range, same-session events', async () => {
    const { status, body } = await get(`${ctx.baseUrl}/api/recordings/rec-1/events`);
    expect(status).toBe(200);
    const ids = (body as any[]).map((e) => e.id).sort();
    expect(ids).toEqual(['span-1', 'span-2', 'span-3']);
  });

  test('GET /api/recordings/:id/events excludes lifecycle noise by default', async () => {
    const seed = new Store(ctx.dataDir);
    seed.putSpan({
      id: 'noise-1',
      sessionId: 'sess-A',
      type: 'bridge_status',
      startTs: '2026-04-19T10:00:45.000Z',
    });
    seed.putSpan({
      id: 'noise-2',
      sessionId: 'sess-A',
      type: 'permission-mode',
      startTs: '2026-04-19T10:00:50.000Z',
    });
    seed.close();

    const r1 = await get(`${ctx.baseUrl}/api/recordings/rec-1/events`);
    const defaultIds = (r1.body as any[]).map((e) => e.id);
    expect(defaultIds).not.toContain('noise-1');
    expect(defaultIds).not.toContain('noise-2');

    const r2 = await get(`${ctx.baseUrl}/api/recordings/rec-1/events?includeLifecycle=1`);
    const withNoise = (r2.body as any[]).map((e) => e.id);
    expect(withNoise).toContain('noise-1');
    expect(withNoise).toContain('noise-2');
  });
});
