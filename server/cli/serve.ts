/**
 * `peek serve` — HTTP-only (optionally with watcher) composed entry point.
 *
 * L1.4 of v0.2.1. Centralises the wiring the CLI previously inlined in
 * `bin/peek.ts` so:
 *
 *   peek serve            → HTTP only (dataDir default: ~/.peek)
 *   peek serve --watch    → HTTP + chokidar on `--claude-dir` (def: ~/.claude/projects)
 *   peek                  → alias for `serve --watch` on port 7335 (or $PEEK_PORT)
 *
 * The returned handle surfaces the bound port (useful when port=0 picks an
 * ephemeral one in tests) and a single `stop()` that tears down both the
 * HTTP listener AND the watcher in order.
 */

import os from 'node:os';
import path from 'node:path';

import { createServer } from '../index';
import { startWatch, type Watcher } from './watch';

export type StartServeOpts = {
  dataDir: string;
  port: number;
  watch: boolean;
  /** Defaults to `~/.claude/projects` when omitted. */
  claudeDir?: string;
  /** Defaults to 127.0.0.1 — see server/index.ts::DEFAULT_BIND_HOST. */
  host?: string;
};

export type ServeHandle = {
  port: number;
  host: string;
  stop: () => Promise<void>;
};

export function defaultClaudeDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export async function startServe(opts: StartServeOpts): Promise<ServeHandle> {
  const handle = createServer({ dataDir: opts.dataDir, port: opts.port, host: opts.host });
  const server = await handle.listen();
  const addr = server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null && 'port' in addr ? (addr as { port: number }).port : opts.port;
  const boundHost =
    typeof addr === 'object' && addr !== null && 'address' in addr
      ? (addr as { address: string }).address
      : (opts.host ?? '127.0.0.1');

  let watcher: Watcher | null = null;
  if (opts.watch) {
    const claudeDir = opts.claudeDir ?? defaultClaudeDir();
    watcher = await startWatch({ dataDir: opts.dataDir, claudeDir });
    // Expose the watcher's live import-queue status to HTTP routes
    // (served by `/api/import-status` — see server/routes/health.ts).
    handle.app.locals.importStatus = () => watcher!.status();
  }

  return {
    port: boundPort,
    host: boundHost,
    async stop() {
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      await handle.close();
    },
  };
}
