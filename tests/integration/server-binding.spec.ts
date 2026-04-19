/**
 * Integration: server binds to 127.0.0.1 only by default (C1 from code review).
 *
 * The README promises "nothing leaves your laptop". Historically `.listen(port)`
 * without an explicit host defaulted to the IPv6 wildcard (`::`), which (with
 * Node's dual-stack behavior) means any host on the LAN can reach the API.
 *
 * Contract:
 *   - Default bind host is 127.0.0.1
 *   - `PEEK_HOST=0.0.0.0` opts into binding all interfaces (escape hatch)
 *   - `server.address().address` reflects the actual bound host
 *   - `curl http://127.0.0.1:<port>/api/healthz` returns 200
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createServer } from '../../server/index';

type Ctx = { close: () => Promise<void> };

describe('server binding (C1)', () => {
  const cleanups: Ctx[] = [];

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop();
      if (c) await c.close();
    }
  });

  test('default bind host is 127.0.0.1 — not :: or 0.0.0.0', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-bind-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();
    cleanups.push({
      close: async () => {
        await handle.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    });
    const addr = server.address() as AddressInfo;
    expect(addr).not.toBeNull();
    expect(addr.address).toBe('127.0.0.1');
  });

  test('GET /api/healthz on 127.0.0.1 returns 200', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-bind-'));
    const handle = createServer({ dataDir, port: 0 });
    const server = await handle.listen();
    cleanups.push({
      close: async () => {
        await handle.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    });
    const addr = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/healthz`);
    expect(res.status).toBe(200);
  });

  test('PEEK_HOST=0.0.0.0 escape hatch binds all interfaces', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-bind-'));
    const handle = createServer({ dataDir, port: 0, host: '0.0.0.0' });
    const server = await handle.listen();
    cleanups.push({
      close: async () => {
        await handle.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    });
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('0.0.0.0');
  });
});
