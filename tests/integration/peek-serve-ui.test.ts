/**
 * Integration tests for BUG-1: `peek serve` must serve the built UI.
 *
 * Previously `server/index.ts` gated static serving on
 * `NODE_ENV === 'production'` (never set by the CLI) AND pointed at
 * `../dist` instead of the real Vite output at `../dist/web`, so `GET /`
 * always returned 404. These tests exercise the real HTTP listener with
 * the actual build artefact on disk so regressions are caught.
 *
 * Pattern mirrors `tests/integration/server.test.ts`:
 *   - per-test tmpdir dataDir via `mkdtempSync`
 *   - ephemeral port via `createServer({ port: 0 })`
 *   - real `fetch` calls against `127.0.0.1:<port>`
 *
 * The hasBuild cases are gated on the existence of `dist/web/index.html`.
 * CI builds before running tests, but a fresh checkout without `npm run
 * build` still gets the no-build case (GET / should 404, not crash).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../server/index';

const DIST_WEB = resolve(__dirname, '..', '..', 'dist', 'web');
const DIST_INDEX = join(DIST_WEB, 'index.html');
const hasBuild = existsSync(DIST_INDEX);

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function boot(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-ui-'));
  const srv = createServer({ dataDir, port: 0 });
  const server = await srv.listen();
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!hasBuild)('peek serve — UI served when build is present', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h.close();
  });

  test('GET / returns the built index.html', async () => {
    const res = await fetch(`${h.baseUrl}/`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<div id="root"></div>');
    expect(body).toContain('<title>Peek</title>');
  });

  test('GET /session/abc-123 falls back to index.html for SPA deep links', async () => {
    const res = await fetch(`${h.baseUrl}/session/abc-123`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<div id="root"></div>');
  });

  test('GET /api/nonexistent still 404s (SPA fallback must not swallow API)', async () => {
    const res = await fetch(`${h.baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe.skipIf(hasBuild)('peek serve — no build present', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h.close();
  });

  test('GET / returns 404 when dist/web is absent (static serving skipped)', async () => {
    const res = await fetch(`${h.baseUrl}/`);
    expect(res.status).toBe(404);
  });
});
