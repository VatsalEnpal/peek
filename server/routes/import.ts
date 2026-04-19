/**
 * Import routes.
 *
 *   POST /api/import/preview — run the pipeline in preview mode (no writes)
 *     and return a summary of sessions we would import.
 *
 *   POST /api/import/commit  — run the full pipeline against a path and
 *     persist into the Store. When the client's Accept header includes
 *     text/event-stream, emits SSE progress; otherwise returns JSON.
 *
 * Thin layer — delegates to `server/pipeline/import.ts`.
 */

import { Router, type Request, type Response } from 'express';

import { importPath, type ImportResult } from '../pipeline/import';

const router = Router();

router.post('/preview', async (req: Request, res: Response) => {
  const { path } = (req.body ?? {}) as { path?: string };
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: "body must include 'path' (string)" });
    return;
  }
  try {
    const result = (await importPath(path, { preview: true })) as ImportResult;
    // Backward-compat: keep the legacy `size` field (which was reused for
    // `totalTokens` in early callers) AND expose the real filesystem size as
    // `sizeBytes` + `mtime`, plus the assembled `slug` so the Import wizard
    // can render slug-first labels just like the landing page.
    const sessions = result.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      slug: s.slug ?? null,
      size: s.totalTokens,
      sizeBytes: s.sizeBytes ?? null,
      mtime: s.mtime ?? null,
      latestTs: s.mtime ?? null,
      turnCount: s.turnCount,
      totalTokens: s.totalTokens,
    }));
    res.json({ sessions, driftWarnings: result.driftWarnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'import preview failed', message });
  }
});

router.post('/commit', async (req: Request, res: Response) => {
  const { path } = (req.body ?? {}) as { path?: string };
  if (typeof path !== 'string' || path.length === 0) {
    res.status(400).json({ error: "body must include 'path' (string)" });
    return;
  }
  const dataDir = req.app.locals.dataDir as string;
  const acceptsSse = (req.headers.accept ?? '').includes('text/event-stream');

  if (acceptsSse) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      send('start', { path });
      const result = (await importPath(path, { dataDir })) as ImportResult;
      send('done', { sessions: result.sessions, driftWarnings: result.driftWarnings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('error', { message });
    } finally {
      res.end();
    }
    return;
  }

  try {
    const result = (await importPath(path, { dataDir })) as ImportResult;
    res.json({ sessions: result.sessions, driftWarnings: result.driftWarnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'import commit failed', message });
  }
});

export default router;
