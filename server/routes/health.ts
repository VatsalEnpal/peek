/**
 * GET /api/healthz — liveness + environment snapshot.
 *
 * Returns status, package version, dataDir, session count (live from store),
 * and the tokenizer method in effect (api when ANTHROPIC_API_KEY is set,
 * otherwise offline). Used by the UI's connection banner and by CLI smoke
 * checks before import.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Router, type Request, type Response } from 'express';

import type { Store } from '../pipeline/store';

const router = Router();

function readPackageVersion(): string {
  try {
    // Walk upward to find package.json. In dev this is the repo root; in the
    // published bundle it's two directories above dist/server/routes.
    const candidates = [
      join(__dirname, '..', '..', 'package.json'),
      join(__dirname, '..', '..', '..', 'package.json'),
    ];
    for (const p of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

router.get('/healthz', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const dataDir = req.app.locals.dataDir as string;
  const sessionCount = store.listSessions().length;
  const tokenizerMethod = process.env.ANTHROPIC_API_KEY ? 'api' : 'offline';
  res.json({
    status: 'ok',
    version: readPackageVersion(),
    dataDir,
    sessionCount,
    tokenizerMethod,
  });
});

/**
 * GET /api/import-status — live view of the watcher's import queue.
 *
 * Present only when `peek serve --watch` is running (i.e. the watcher wired
 * itself onto `app.locals.importStatus`). Returns:
 *   {
 *     watching: true,
 *     importedCount: number,     // files finished since startup
 *     queueLength: number,       // files waiting
 *     inProgress: boolean,       // worker currently busy
 *     currentFile: string | null // path of the file being imported
 *   }
 *
 * When the watcher is NOT running (e.g. plain `peek serve`) the route
 * returns `{ watching: false }` with a 200, so the UI can safely poll.
 *
 * Motivation: on first launch against a long-lived `~/.claude/projects`
 * (hundreds of existing sessions), the import queue can take several
 * minutes to drain. The UI polls this endpoint to render a
 * "Importing N of M sessions…" indicator instead of an empty page.
 */
router.get('/import-status', (req: Request, res: Response) => {
  const fn = req.app.locals.importStatus as (() => unknown) | undefined;
  if (typeof fn !== 'function') {
    res.json({ watching: false });
    return;
  }
  const snap = fn() as {
    importedCount: number;
    queueLength: number;
    inProgress: boolean;
    currentFile: string | null;
  };
  res.json({ watching: true, ...snap });
});

export default router;
