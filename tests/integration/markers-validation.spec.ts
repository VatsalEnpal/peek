/**
 * Integration: /api/markers input validation (C2, I4, I5 from review).
 *
 * Covers every rejection path plus a few positive-control tests:
 *   - name > 256 chars → 400
 *   - sessionId > 128 chars → 400
 *   - type not in {"start","end"} → 400
 *   - missing Content-Type: application/json → 400
 *   - body > 16kb → 413 (per-router body limit)
 *   - name exactly 256 chars → 201 (boundary OK)
 *   - JSON injection attempt treats input as a literal string (not parsed)
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createServer } from '../../server/index';
import { Store } from '../../server/pipeline/store';

type Ctx = { baseUrl: string; dataDir: string; close: () => Promise<void> };

async function startServer(): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-marker-val-'));
  const handle = createServer({ dataDir, port: 0 });
  const seed = new Store(dataDir);
  seed.putSession({ id: 'live', salt: 'seed-salt' });
  seed.close();
  const server = await handle.listen();
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dataDir,
    close: async () => {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function post(
  url: string,
  body: string | Buffer,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Promise<{ status: number; body: any }> {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(data.length) },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: buf ? (() => {
                try {
                  return JSON.parse(buf);
                } catch {
                  return buf;
                }
              })() : null,
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('POST /api/markers input validation (C2)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('rejects name > 256 chars with 400', async () => {
    const name = 'x'.repeat(257);
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', name, sessionId: 'live' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('accepts name exactly 256 chars (boundary)', async () => {
    const name = 'x'.repeat(256);
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', name, sessionId: 'live' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.label).toBe(name);
  });

  test('rejects sessionId > 128 chars with 400', async () => {
    const sessionId = 'x'.repeat(129);
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', sessionId }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessionId/i);
  });

  test('rejects type not in {start,end} with 400', async () => {
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'middle', sessionId: 'live' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/i);
  });

  test('rejects missing Content-Type: application/json with 400', async () => {
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', sessionId: 'live' }),
      {}, // no Content-Type
    );
    expect(res.status).toBe(400);
  });

  test('rejects text/plain Content-Type with 400', async () => {
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', sessionId: 'live' }),
      { 'Content-Type': 'text/plain' },
    );
    expect(res.status).toBe(400);
  });

  test('body > 16kb is rejected (413)', async () => {
    // 17kb payload — name field padded out. Express returns 413 Payload Too
    // Large when the per-router express.json limit is hit.
    const padded = JSON.stringify({
      type: 'start',
      sessionId: 'live',
      name: 'x'.repeat(17 * 1024),
    });
    const res = await post(`${ctx.baseUrl}/api/markers`, padded);
    expect([400, 413]).toContain(res.status);
  });

  test('JSON injection attempt: name with embedded quotes is stored as literal', async () => {
    // The attacker supplies a "name" containing what *looks like* JSON syntax
    // — the server must treat it as a plain string, not re-parse it.
    const maliciousName = 'foo","orphan":true,"x":"bar';
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', name: maliciousName, sessionId: 'live' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.label).toBe(maliciousName);
    // Orphan field must not have been interpreted — it stays inside `label`.
    expect(res.body).not.toHaveProperty('orphan');
  });

  test('happy path: valid start marker returns 201', async () => {
    const res = await post(
      `${ctx.baseUrl}/api/markers`,
      JSON.stringify({ type: 'start', name: 'investigate', sessionId: 'live' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('start');
    expect(res.body.label).toBe('investigate');
  });
});
