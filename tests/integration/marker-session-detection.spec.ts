/**
 * Integration (L11a): POST /api/markers attaches to the most-recently-active
 * Claude Code session instead of the synthetic sentinel `"live"`.
 *
 * Contract:
 *   - When a watcher has imported N JSONL files, `getCurrentSessionId()` must
 *     return the basename (minus `.jsonl`) of the most recently imported one.
 *   - POST /api/markers with no sessionId body → bookmark row's session_id is
 *     the current session id, NOT the literal `"live"`.
 *   - POST /api/markers with explicit sessionId body → explicit wins.
 *   - If no JSONL has ever been imported, falls back to `"live"` for
 *     back-compat (fresh daemon, no CC activity yet).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';
import { startWatch, type Watcher } from '../../server/cli/watch';
import { resetCurrentSessionId } from '../../server/cli/current-session';

type Ctx = {
  baseUrl: string;
  dataDir: string;
  claudeDir: string;
  watcher: Watcher | null;
  close: () => Promise<void>;
};

async function startCtx(withWatcher: boolean): Promise<Ctx> {
  resetCurrentSessionId();
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-l11-data-'));
  const claudeDir = mkdtempSync(join(tmpdir(), 'peek-l11-claude-'));
  const handle = createServer({ dataDir, port: 0 });
  const server = await handle.listen();
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no addr');
  const watcher = withWatcher ? await startWatch({ dataDir, claudeDir }) : null;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir,
    claudeDir,
    watcher,
    close: async () => {
      if (watcher) await watcher.stop();
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
      resetCurrentSessionId();
    },
  };
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/** Build a minimal valid user-prompt JSONL line. */
function userPrompt(sessionId: string, uuid: string, ts: string, text: string): string {
  return line({
    type: 'user',
    uuid,
    sessionId,
    cwd: '/tmp/l11-test',
    gitBranch: 'main',
    version: '1.0.0',
    entrypoint: 'cli',
    timestamp: ts,
    message: { role: 'user', content: text },
  });
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

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('POST /api/markers — session detection (L11a)', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await ctx.close();
  });

  test('marker without sessionId attaches to the most-recently-appended JSONL basename', async () => {
    ctx = await startCtx(true);
    // Write session A first.
    const fileA = join(ctx.claudeDir, 'aaaa-1111.jsonl');
    writeFileSync(fileA, userPrompt('aaaa-1111', 'u1', '2026-04-19T10:00:00Z', 'first session'));
    await waitMs(300);

    // Then session B, which becomes the "current" session.
    const fileB = join(ctx.claudeDir, 'bbbb-2222.jsonl');
    writeFileSync(fileB, userPrompt('bbbb-2222', 'u2', '2026-04-19T10:01:00Z', 'second session'));
    await waitMs(300);

    const res = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'Test_vatsal',
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('bbbb-2222');

    // Verify persisted bookmark row belongs to session B.
    const store = new Store(ctx.dataDir);
    try {
      const bms = store.listBookmarks('bbbb-2222');
      expect(bms.find((b) => b.label === 'Test_vatsal')).toBeDefined();
      const live = store.listBookmarks('live');
      expect(live.find((b) => b.label === 'Test_vatsal')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('explicit sessionId in body wins over detected current session', async () => {
    ctx = await startCtx(true);
    const fileA = join(ctx.claudeDir, 'aaaa-1111.jsonl');
    writeFileSync(fileA, userPrompt('aaaa-1111', 'u1', '2026-04-19T10:00:00Z', 'session A'));
    await waitMs(300);

    // Seed a target session explicitly (bookmark FK needs the row to exist).
    const seed = new Store(ctx.dataDir);
    try {
      seed.putSession({ id: 'explicit-id', salt: 'seed' });
    } finally {
      seed.close();
    }

    const res = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'explicit-win',
      sessionId: 'explicit-id',
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('explicit-id');
  });

  test('falls back to "live" when no JSONL has been imported yet', async () => {
    // Server without watcher + no current-session set = first-run scenario.
    ctx = await startCtx(false);

    const res = await postJson(`${ctx.baseUrl}/api/markers`, {
      type: 'start',
      name: 'first-run',
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe('live');
  });
});
