/**
 * Integration tests for the Express server bundle (Group 6 — Tasks 6.1/6.2/6.3).
 *
 * Spins up a real HTTP listener on an ephemeral port (`.listen(0)`) and
 * exercises every route group with `fetch`. Fixture data is imported into a
 * per-test `mkdtempSync` dataDir so tests stay hermetic and parallel-safe.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createServer } from '../../server/index';
import { importPath } from '../../server/pipeline/import';

type Harness = {
  baseUrl: string;
  dataDir: string;
  fixtureFile: string;
  close: () => Promise<void>;
  server: Server;
};

function makeTinyJsonl(): string {
  const events = [
    {
      type: 'user',
      uuid: 'srv-u-1',
      sessionId: 'srv-session-1',
      cwd: '/tmp/srv',
      gitBranch: 'main',
      version: '1.0.0',
      entrypoint: 'cli',
      timestamp: '2026-04-18T09:00:00Z',
      message: { role: 'user', content: 'ping from integration test' },
    },
    {
      type: 'assistant',
      uuid: 'srv-a-1',
      parentUuid: 'srv-u-1',
      sessionId: 'srv-session-1',
      timestamp: '2026-04-18T09:00:01Z',
      message: {
        role: 'assistant',
        id: 'msg-srv-001',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'pong from fixture' }],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

async function bootEmpty(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-srv-'));
  const fixtureFile = join(dataDir, 'tiny.jsonl');
  writeFileSync(fixtureFile, makeTinyJsonl(), 'utf8');

  const srv = createServer({ dataDir, port: 0 });
  const server = await srv.listen();
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    dataDir,
    fixtureFile,
    server,
    close: async () => {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function bootWithFixture(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-srv-'));
  const fixtureFile = join(dataDir, 'tiny.jsonl');
  writeFileSync(fixtureFile, makeTinyJsonl(), 'utf8');

  // Import before creating the server so the Store opens onto populated data.
  await importPath(fixtureFile, { dataDir });

  const srv = createServer({ dataDir, port: 0 });
  const server = await srv.listen();
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir,
    fixtureFile,
    server,
    close: async () => {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe('server /api/healthz', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootEmpty();
  });
  afterAll(async () => {
    await h.close();
  });

  test('returns 200 with expected shape', async () => {
    const res = await fetch(`${h.baseUrl}/api/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.dataDir).toBe(h.dataDir);
    expect(typeof body.sessionCount).toBe('number');
    expect(['api', 'offline']).toContain(body.tokenizerMethod);
  });

  test('CORS header present for localhost origin', async () => {
    const res = await fetch(`${h.baseUrl}/api/healthz`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  test('no CORS header for non-localhost origin', async () => {
    const res = await fetch(`${h.baseUrl}/api/healthz`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('server /api/sessions (empty)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootEmpty();
  });
  afterAll(async () => {
    await h.close();
  });

  test('returns empty array before import', async () => {
    const res = await fetch(`${h.baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe('server /api/sessions (after import)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootWithFixture();
  });
  afterAll(async () => {
    await h.close();
  });

  test('lists one session with camelCase fields', async () => {
    const res = await fetch(`${h.baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    const s = body[0];
    expect(typeof s.id).toBe('string');
    expect('label' in s).toBe(true);
    expect('firstPrompt' in s).toBe(true);
    expect('turnCount' in s).toBe(true);
    expect('totalTokens' in s).toBe(true);
    expect('timeAgo' in s).toBe(true);
    // no snake_case leaks
    expect('first_prompt' in s).toBe(false);
    expect('turn_count' in s).toBe(false);
  });

  test('returns events for a session', async () => {
    const listRes = await fetch(`${h.baseUrl}/api/sessions`);
    const list = (await listRes.json()) as Array<{ id: string }>;
    const id = list[0].id;

    const res = await fetch(`${h.baseUrl}/api/sessions/${encodeURIComponent(id)}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test('404 for unknown session events', async () => {
    const res = await fetch(`${h.baseUrl}/api/sessions/nope-nope-nope/events`);
    expect(res.status).toBe(404);
  });
});

describe('server /api/import/preview', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootEmpty();
  });
  afterAll(async () => {
    await h.close();
  });

  test('returns session preview without writing', async () => {
    const res = await fetch(`${h.baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: h.fixtureFile }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);

    // Confirm nothing was persisted to the store — /api/sessions still empty.
    const listRes = await fetch(`${h.baseUrl}/api/sessions`);
    const list = (await listRes.json()) as unknown[];
    expect(list.length).toBe(0);
  });

  test('400 when path missing', async () => {
    const res = await fetch(`${h.baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('server /api/bookmarks', () => {
  let h: Harness;
  let sessionId: string;

  beforeAll(async () => {
    h = await bootWithFixture();
    const list = (await (await fetch(`${h.baseUrl}/api/sessions`)).json()) as Array<{ id: string }>;
    sessionId = list[0].id;
  });
  afterAll(async () => {
    await h.close();
  });

  test('POST then GET round-trip', async () => {
    const postRes = await fetch(`${h.baseUrl}/api/bookmarks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        label: 'integration-test-bookmark',
        source: 'manual',
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; label: string };
    expect(typeof created.id).toBe('string');
    expect(created.label).toBe('integration-test-bookmark');

    const getRes = await fetch(
      `${h.baseUrl}/api/bookmarks?sessionId=${encodeURIComponent(sessionId)}`
    );
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()) as Array<{ id: string; label: string }>;
    expect(list.some((b) => b.id === created.id && b.label === 'integration-test-bookmark')).toBe(
      true
    );
  });
});

describe('server /api/unmask', () => {
  let h: Harness;
  let ledgerEntryId: string;

  beforeAll(async () => {
    h = await bootWithFixture();
    // Fetch a ledger entry id via the events endpoint.
    const list = (await (await fetch(`${h.baseUrl}/api/sessions`)).json()) as Array<{ id: string }>;
    const eventsRes = await fetch(
      `${h.baseUrl}/api/sessions/${encodeURIComponent(list[0].id)}/events`
    );
    const events = (await eventsRes.json()) as Array<{
      kind: string;
      id: string;
      sourceOffset?: unknown;
    }>;
    const ledger = events.find((e) => e.kind === 'ledger' && e.sourceOffset);
    if (!ledger) throw new Error('no ledger entry with sourceOffset in fixture');
    ledgerEntryId = ledger.id;
  });
  afterAll(async () => {
    await h.close();
  });

  test('rejects without X-Unmask-Confirm header', async () => {
    const res = await fetch(`${h.baseUrl}/api/unmask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledgerEntryId }),
    });
    expect(res.status).toBe(400);
  });

  test('returns plaintext with Cache-Control: no-store when confirmed', async () => {
    const res = await fetch(`${h.baseUrl}/api/unmask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unmask-confirm': '1',
      },
      body: JSON.stringify({ ledgerEntryId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { plaintext: string };
    expect(typeof body.plaintext).toBe('string');
    // Sanity: the fixture file still exists and the plaintext is a substring of it.
    const raw = readFileSync(h.fixtureFile, 'utf8');
    expect(raw.includes(body.plaintext.slice(0, 10)) || body.plaintext.length === 0).toBe(true);
  });

  test('404 for unknown ledgerEntryId', async () => {
    const res = await fetch(`${h.baseUrl}/api/unmask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unmask-confirm': '1',
      },
      body: JSON.stringify({ ledgerEntryId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });
});
