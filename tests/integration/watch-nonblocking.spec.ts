/**
 * Regression: `peek serve --watch` must NOT block the HTTP event loop while
 * importing the initial on-disk scan.
 *
 * v0.2.1 bug repro — when chokidar's initial scan fires `add` for N existing
 * JSONL files (e.g. 50+ sessions accumulated from months of Claude Code use),
 * the watcher's per-file `importPath()` + `snapshotStore()` work pegs the
 * event loop at 100% CPU for many seconds. During that window `GET /api/healthz`
 * times out even though the port is bound and the listener is accepting.
 *
 * Contract this test enforces: after `startServe({ watch: true })` resolves
 * against a claudeDir containing 50 pre-existing JSONL files, a subsequent
 * `/api/healthz` request completes in <2s. The fix must yield the event loop
 * between imports so HTTP requests are serviced while the import queue drains.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { startServe, type ServeHandle } from '../../server/cli/serve';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Create a valid-but-non-trivial JSONL session file so importPath actually
 * does meaningful work (mirrors the real ~/.claude/projects payloads).
 */
function writeFixtureSession(path: string, sessionId: string): void {
  const turns: string[] = [];
  const baseTs = new Date('2026-04-01T10:00:00Z').getTime();
  let prevUuid: string | null = null;
  // 10 turns per session → ~20 JSONL lines per file, matching the median
  // line count seen in real ~/.claude/projects transcripts on a daily-use
  // machine. Important for the test: each file must be small enough that
  // a single import completes in well under the 2s healthz budget, so we
  // can prove the queue yields BETWEEN imports. Before the fix, dozens of
  // concurrent `await importFile` promises saturate the loop regardless
  // of per-file size.
  for (let i = 0; i < 10; i++) {
    const userUuid = `${sessionId}-u-${i}`;
    const asstUuid = `${sessionId}-a-${i}`;
    const userEvt: Record<string, unknown> = {
      type: 'user',
      uuid: userUuid,
      sessionId,
      cwd: '/tmp/nonblock',
      gitBranch: 'main',
      version: '1.0.0',
      entrypoint: 'cli',
      timestamp: new Date(baseTs + i * 2000).toISOString(),
      message: { role: 'user', content: `prompt ${i} for ${sessionId}` },
    };
    if (prevUuid) userEvt.parentUuid = prevUuid;
    turns.push(line(userEvt));
    turns.push(
      line({
        type: 'assistant',
        uuid: asstUuid,
        parentUuid: userUuid,
        sessionId,
        timestamp: new Date(baseTs + i * 2000 + 500).toISOString(),
        message: {
          role: 'assistant',
          id: `msg-${asstUuid}`,
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: `response ${i} body text payload` }],
          usage: {
            input_tokens: 50,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })
    );
    prevUuid = asstUuid;
  }
  writeFileSync(path, turns.join(''));
}

function httpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c.toString('utf8')));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, elapsedMs: Date.now() - start })
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP GET ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

describe('startServe({ watch: true }) — non-blocking initial import', () => {
  let dataDir: string;
  let claudeDir: string;
  let handle: ServeHandle | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'peek-nonblock-data-'));
    claudeDir = mkdtempSync(join(tmpdir(), 'peek-nonblock-claude-'));
    // Seed 80 valid JSONL fixtures under claudeDir/projects/<id>/.
     // Matches the order-of-magnitude file count on a real machine that has
     // been using Claude Code for several weeks (the reporter had 93).
    for (let i = 0; i < 80; i++) {
      const projDir = join(claudeDir, `project-${i}`);
      mkdirSync(projDir, { recursive: true });
      writeFixtureSession(join(projDir, `session-${i}.jsonl`), `nonblock-session-${i}`);
    }
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  test(
    'GET /api/healthz responds <2s while 80 initial imports are being processed',
    { timeout: 30_000 },
    async () => {
    handle = await startServe({
      dataDir,
      claudeDir,
      port: 0,
      watch: true,
    });

    // chokidar fires 'add' during the initial scan, which the watcher
    // debounces at 100ms. We wait ~200ms so the debounce fires and the
    // import workers are actively running when we probe healthz. Pre-fix,
    // the event loop is saturated by synchronous parse + SQLite write work
    // across every queued file at once and healthz times out (>2s). Post-fix,
    // the queue drains one-at-a-time with setImmediate yields between
    // imports so HTTP requests interleave freely.
    await new Promise((r) => setTimeout(r, 200));

    const res = await httpGet(`http://127.0.0.1:${handle.port}/api/healthz`, 2000);
    expect(res.status).toBe(200);
    expect(res.elapsedMs).toBeLessThan(2000);
    const parsed = JSON.parse(res.body) as { status: string };
    expect(parsed.status).toBe('ok');
    }
  );
});
