/**
 * Integration: `startWatch` — the file watcher daemon (L1.1).
 *
 * Contract:
 *   const { stop } = await startWatch({ dataDir, claudeDir });
 *   // when a new .jsonl lands under claudeDir, it gets full-imported
 *   // when an existing .jsonl grows, the delta gets incrementally imported
 *   // SSE `session:new` is broadcast after first-time import
 *   stop(); // releases fs handles
 *
 * We exercise both new-file and append paths against a tmp directory and
 * assert Store state + SSE broadcast after each.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';
import { startWatch } from '../../server/cli/watch';

type Ctx = { baseUrl: string; dataDir: string; claudeDir: string; close: () => Promise<void> };

async function startCtx(): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-watch-data-'));
  const claudeDir = mkdtempSync(join(tmpdir(), 'peek-watch-claude-'));
  const handle = createServer({ dataDir, port: 0 });
  const server = await handle.listen();
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no addr');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir,
    claudeDir,
    close: async () => {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    },
  };
}

/** Build one valid JSONL line. */
function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function userEvent(opts: { uuid: string; sessionId: string; ts: string; text: string; parentUuid?: string }): string {
  const evt: Record<string, unknown> = {
    type: 'user',
    uuid: opts.uuid,
    sessionId: opts.sessionId,
    cwd: '/tmp/watch',
    gitBranch: 'main',
    version: '1.0.0',
    entrypoint: 'cli',
    timestamp: opts.ts,
    message: { role: 'user', content: opts.text },
  };
  if (opts.parentUuid) evt.parentUuid = opts.parentUuid;
  return line(evt);
}

function assistantEvent(opts: {
  uuid: string;
  parentUuid: string;
  sessionId: string;
  ts: string;
  outputTokens: number;
}): string {
  return line({
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    message: {
      role: 'assistant',
      id: `msg-${opts.uuid}`,
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1,
        output_tokens: opts.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

function openSseAndCollect(
  baseUrl: string,
  count: number,
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/events/stream`,
      { headers: { Accept: 'text/event-stream' } },
      (res) => {
        let buf = '';
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error(`sse timeout waiting for ${count}; got=${JSON.stringify(buf)}`));
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
      }
    );
    req.on('error', reject);
  });
}

/** Small helper: poll a predicate until true or timeout. */
async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('startWatch (L1.1)', () => {
  let ctx: Ctx;
  let stopWatch: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    ctx = await startCtx();
  });

  afterEach(async () => {
    if (stopWatch) await stopWatch();
    stopWatch = null;
    await ctx.close();
  });

  test('new .jsonl file under claudeDir → session imported + SSE session:new', async () => {
    const projectDir = join(ctx.claudeDir, 'project-x');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = join(projectDir, 'session-A.jsonl');

    // Start SSE subscriber BEFORE the watcher so we can catch session:new.
    const sseP = openSseAndCollect(ctx.baseUrl, 1);

    const watcher = await startWatch({ dataDir: ctx.dataDir, claudeDir: ctx.claudeDir });
    stopWatch = async () => watcher.stop();

    // Give chokidar a tick to register before writing.
    await new Promise((r) => setTimeout(r, 150));

    writeFileSync(
      jsonl,
      userEvent({
        uuid: 'u-1',
        sessionId: 'watch-session-1',
        ts: '2026-04-19T16:00:00Z',
        text: 'hello',
      })
    );

    // Wait for the session to appear in the store.
    await waitFor(() => {
      const s = new Store(ctx.dataDir);
      try {
        const sessions = (s as any).db.prepare('SELECT id FROM sessions').all() as {
          id: string;
        }[];
        return sessions.some((r) => r.id === 'watch-session-1') ? true : undefined;
      } finally {
        s.close();
      }
    });

    // SSE broadcast arrived.
    const buf = await sseP;
    expect(buf).toMatch(/event: session:new/);
    expect(buf).toMatch(/"sessionId":"watch-session-1"/);
  });

  test('L5-followup: claudeDir that does NOT exist yet is created and watched', async () => {
    // Repro: first-time user runs `peek install` then `peek` before any
    // Claude Code session has ever run. On their machine,
    // `~/.claude/projects/` may not exist — the watcher must create it
    // AND notice files that land there afterward, not silently watch
    // nothing.
    const nonexistent = join(ctx.claudeDir, 'brand-new-dir-that-did-not-exist');

    const watcher = await startWatch({
      dataDir: ctx.dataDir,
      claudeDir: nonexistent,
    });
    stopWatch = async () => watcher.stop();

    // Wait a tick for the watcher to settle.
    await new Promise((r) => setTimeout(r, 150));

    const projectDir = join(nonexistent, 'proj-ne');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = join(projectDir, 'ne.jsonl');
    writeFileSync(
      jsonl,
      userEvent({
        uuid: 'u-ne',
        sessionId: 'watch-session-ne',
        ts: '2026-04-19T19:00:00Z',
        text: 'hi from a fresh dir',
      })
    );

    await waitFor(
      () => {
        const s = new Store(ctx.dataDir);
        try {
          const sessions = (s as any).db
            .prepare('SELECT id FROM sessions WHERE id = ?')
            .all('watch-session-ne') as { id: string }[];
          return sessions.length > 0 ? true : undefined;
        } finally {
          s.close();
        }
      },
      3000,
      50
    );
  });

  test('L5-followup: claudeDir whose ancestor path contains a dot-segment (e.g. ~/.claude) is NOT ignored', async () => {
    // Repro of the silent no-op daemon bug: when the user runs plain `peek`,
    // the default watched directory is `~/.claude/projects`. If the ignored
    // predicate matches ANY dot-segment in the absolute path (including
    // ancestors), every descendant under `~/.claude/*` is rejected and the
    // daemon silently imports nothing. This test creates a fake ".claude"
    // ancestor then verifies imports still happen under it.
    const hiddenRoot = join(ctx.claudeDir, '.claude');
    const projectDir = join(hiddenRoot, 'projects', 'my-project');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = join(projectDir, 'uat.jsonl');

    const watcher = await startWatch({
      dataDir: ctx.dataDir,
      claudeDir: join(hiddenRoot, 'projects'),
    });
    stopWatch = async () => watcher.stop();

    // Wait a tick so the watcher registers.
    await new Promise((r) => setTimeout(r, 150));

    writeFileSync(
      jsonl,
      userEvent({
        uuid: 'u-dot',
        sessionId: 'watch-session-dot',
        ts: '2026-04-19T18:00:00Z',
        text: 'hi from under .claude',
      })
    );

    await waitFor(
      () => {
        const s = new Store(ctx.dataDir);
        try {
          const sessions = (s as any).db
            .prepare('SELECT id FROM sessions WHERE id = ?')
            .all('watch-session-dot') as { id: string }[];
          return sessions.length > 0 ? true : undefined;
        } finally {
          s.close();
        }
      },
      3000,
      50
    );
  });

  test('appending to existing .jsonl → incremental import adds span + SSE span:new', async () => {
    const projectDir = join(ctx.claudeDir, 'project-y');
    mkdirSync(projectDir, { recursive: true });
    const jsonl = join(projectDir, 'session-B.jsonl');
    // Seed: one user prompt.
    writeFileSync(
      jsonl,
      userEvent({
        uuid: 'u-1',
        sessionId: 'watch-session-2',
        ts: '2026-04-19T17:00:00Z',
        text: 'first',
      })
    );

    const watcher = await startWatch({ dataDir: ctx.dataDir, claudeDir: ctx.claudeDir });
    stopWatch = async () => watcher.stop();

    // First, wait for initial import.
    await waitFor(() => {
      const s = new Store(ctx.dataDir);
      try {
        const sessions = (s as any).db
          .prepare('SELECT id FROM sessions WHERE id = ?')
          .all('watch-session-2') as { id: string }[];
        return sessions.length > 0 ? true : undefined;
      } finally {
        s.close();
      }
    });

    // Capture span count before append.
    const countSpans = (): number => {
      const s = new Store(ctx.dataDir);
      try {
        const rows = (s as any).db
          .prepare('SELECT COUNT(*) AS c FROM action_spans WHERE session_id = ?')
          .get('watch-session-2') as { c: number };
        return rows.c;
      } finally {
        s.close();
      }
    };
    const before = countSpans();

    // Append an assistant turn to the same file.
    appendFileSync(
      jsonl,
      assistantEvent({
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'watch-session-2',
        ts: '2026-04-19T17:00:05Z',
        outputTokens: 42,
      })
    );

    await waitFor(() => (countSpans() > before ? true : undefined));

    // Verify the exact 42 output-tokens value persisted somewhere in turns.
    const s = new Store(ctx.dataDir);
    try {
      const rows = (s as any).db
        .prepare('SELECT usage_json FROM turns WHERE session_id = ?')
        .all('watch-session-2') as { usage_json: string | null }[];
      const joined = rows.map((r) => r.usage_json ?? '').join('|');
      expect(joined).toMatch(/"outputTokens":42/);
    } finally {
      s.close();
    }
  });
});
