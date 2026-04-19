/**
 * Express server shell for peek-trace.
 *
 * Exports:
 *   - `createServer({ dataDir, port? })` — wiring factory used by both the CLI
 *     (`bin/peek.ts serve`) and integration tests. Returns `{ app, listen,
 *     close }`. Listening on port 0 yields an ephemeral port so tests can
 *     run in parallel.
 *   - `startServer({ port? })` — kept for backwards compatibility with the
 *     scaffold's CLI wiring. Resolves the default dataDir from
 *     `PEEK_DATA_DIR` or `$HOME/.peek`.
 *
 * The factory mounts a single `Store` instance on `app.locals.store` so
 * route modules can access the DB without re-opening connections. CORS is
 * restricted to `http://localhost:*` (any port) with a tiny hand-rolled
 * middleware — avoids pulling in the `cors` dependency for five lines of
 * regex. Graceful shutdown closes both the HTTP listener and the Store.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import express, { type Express, type Request, type Response, type NextFunction } from 'express';

import { Store } from './pipeline/store';
import healthRouter from './routes/health';
import sessionsRouter from './routes/sessions';
import importRouter from './routes/import';
import bookmarksRouter from './routes/bookmarks';
import unmaskRouter from './routes/unmask';
import openRouter from './routes/open';
import sseRouter from './api/sse';

const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

export type CreateServerOpts = {
  dataDir: string;
  port?: number;
};

export type ServerHandle = {
  app: Express;
  listen: () => Promise<http.Server>;
  close: () => Promise<void>;
};

export function createServer(opts: CreateServerOpts): ServerHandle {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // CORS — localhost only, any port. Hand-rolled to keep deps minimal.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && LOCALHOST_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Unmask-Confirm,Accept,Origin');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const store = new Store(opts.dataDir);
  app.locals.store = store;
  app.locals.dataDir = opts.dataDir;

  app.use('/api', healthRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/import', importRouter);
  app.use('/api/bookmarks', bookmarksRouter);
  app.use('/api/unmask', unmaskRouter);
  app.use('/api/open', openRouter);
  app.use('/api/events', sseRouter);

  // Static serving for the Vite bundle. Always mount if a build exists on
  // disk — the CLI never sets NODE_ENV=production, and the old gate meant
  // `peek serve` shipped a dead UI. Two candidate layouts: dev/CI runs
  // against source so `__dirname` is `<repo>/server` and the build lands
  // at `<repo>/dist/web`; the compiled CLI runs from `<repo>/dist/bin` via
  // the server compiled to `<repo>/dist/server`, so we also check the
  // sibling `web/` layout. Mounted AFTER all /api routes so API 404s are
  // never swallowed. The SPA fallback regex excludes `/api/*` so deep
  // links like `/session/abc-123` resolve to `index.html`.
  const distCandidates = [resolve(__dirname, '..', 'dist', 'web'), resolve(__dirname, '..', 'web')];
  const distDir = distCandidates.find((p) => existsSync(join(p, 'index.html')));

  if (distDir) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(join(distDir, 'index.html'));
    });
  }

  let server: http.Server | null = null;

  return {
    app,
    async listen() {
      const port = opts.port ?? 7334;
      server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(port, () => resolve(s));
      });
      return server;
    },
    async close() {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
      try {
        store.close();
      } catch {
        /* store may already be closed */
      }
    },
  };
}

/**
 * Legacy scaffold entry point — kept so `bin/peek.ts` continues to import
 * `startServer` without change. Resolves dataDir from `PEEK_DATA_DIR` or
 * `$HOME/.peek`, binds SIGTERM/SIGINT for graceful shutdown, and logs the
 * listener URL to stdout.
 */
export async function startServer(opts: { port?: number; dataDir?: string } = {}): Promise<void> {
  const dataDir =
    opts.dataDir ?? process.env.PEEK_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.peek');
  const port = opts.port ?? Number(process.env.PEEK_PORT ?? 7334);

  const handle = createServer({ dataDir, port });
  const server = await handle.listen();
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  // eslint-disable-next-line no-console
  console.log(`peek listening on http://localhost:${boundPort} (dataDir=${dataDir})`);

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('peek: shutting down...');
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
