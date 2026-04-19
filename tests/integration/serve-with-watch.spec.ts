/**
 * Integration: `startServe({ watch: true })` boots an HTTP server AND a
 * chokidar watcher in one handle — L1.4 wiring.
 *
 * We don't re-test the watcher or the SSE plumbing here (that's L1.1/L1.2);
 * we only assert the two get composed into a single lifecycle so both
 * `peek serve --watch` and plain `peek` have the same shape.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { startServe } from '../../server/cli/serve';
import { Store } from '../../server/pipeline/store';

type Fx = { dataDir: string; claudeDir: string };

function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: buf ? JSON.parse(buf) : null,
            });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000, interval = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('startServe (L1.4)', () => {
  let fx: Fx;

  beforeEach(() => {
    fx = {
      dataDir: mkdtempSync(join(tmpdir(), 'peek-serve-data-')),
      claudeDir: mkdtempSync(join(tmpdir(), 'peek-serve-claude-')),
    };
  });

  afterEach(() => {
    rmSync(fx.dataDir, { recursive: true, force: true });
    rmSync(fx.claudeDir, { recursive: true, force: true });
  });

  test('startServe({watch:true}) serves HTTP + imports JSONL appearing in claudeDir', async () => {
    const handle = await startServe({
      dataDir: fx.dataDir,
      port: 0,
      watch: true,
      claudeDir: fx.claudeDir,
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      // Health endpoint responds.
      const health = await getJson(`http://127.0.0.1:${handle.port}/api/healthz`);
      expect(health.status).toBe(200);

      // Drop a JSONL; watcher should import it.
      const projectDir = join(fx.claudeDir, 'project-z');
      mkdirSync(projectDir, { recursive: true });
      const jsonl = join(projectDir, 'session-S.jsonl');
      const evt = {
        type: 'user',
        uuid: 'uS',
        sessionId: 'serve-session-1',
        cwd: '/tmp',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-19T20:00:00Z',
        message: { role: 'user', content: 'hi' },
      };
      writeFileSync(jsonl, JSON.stringify(evt) + '\n');

      await waitFor(() => {
        const s = new Store(fx.dataDir);
        try {
          const rows = (s as any).db
            .prepare('SELECT id FROM sessions WHERE id = ?')
            .all('serve-session-1') as { id: string }[];
          return rows.length > 0 ? true : undefined;
        } finally {
          s.close();
        }
      });
    } finally {
      await handle.stop();
    }
  });

  test('startServe({watch:false}) only starts HTTP (no watcher)', async () => {
    const handle = await startServe({
      dataDir: fx.dataDir,
      port: 0,
      watch: false,
      claudeDir: fx.claudeDir,
    });
    try {
      const health = await getJson(`http://127.0.0.1:${handle.port}/api/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });
});
