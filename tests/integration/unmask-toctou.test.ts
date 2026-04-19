/**
 * Integration test for BUG-7 (TOCTOU on /api/unmask).
 *
 * Ensures the handler re-hashes the source line and rejects with 409 when the
 * on-disk JSONL has been mutated between import time and unmask time.
 *
 * Operates on a temp copy of the fixture — the shared fixture under
 * tests/fixtures/ is never mutated.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createServer } from '../../server/index';
import { importPath } from '../../server/pipeline/import';

const SOURCE_FIXTURE = join(__dirname, '..', 'fixtures', 'session-with-secrets.jsonl');

type Harness = {
  baseUrl: string;
  dataDir: string;
  fixtureFile: string;
  ledgerEntryId: string;
  byteStart: number;
  server: Server;
  close: () => Promise<void>;
};

async function boot(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'peek-toctou-'));
  const fixtureFile = join(dataDir, 'session-with-secrets.jsonl');
  copyFileSync(SOURCE_FIXTURE, fixtureFile);

  await importPath(fixtureFile, { dataDir });

  const srv = createServer({ dataDir, port: 0 });
  const server = await srv.listen();
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Locate a ledger entry with a sourceOffset pointing at the copied file.
  const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string }>;
  const eventsRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(list[0].id)}/events`);
  const events = (await eventsRes.json()) as Array<{
    kind: string;
    id: string;
    sourceOffset?: { file: string; byteStart: number; byteEnd: number; sourceLineHash: string };
  }>;
  const ledger = events.find(
    (e) => e.kind === 'ledger' && e.sourceOffset && e.sourceOffset.file === fixtureFile
  );
  if (!ledger || !ledger.sourceOffset) {
    throw new Error('no ledger entry with sourceOffset on the copied fixture');
  }

  return {
    baseUrl,
    dataDir,
    fixtureFile,
    ledgerEntryId: ledger.id,
    byteStart: ledger.sourceOffset.byteStart,
    server,
    close: async () => {
      await srv.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Flip a single byte on the JSONL line that contains `byteStart`, without
 * touching any surrounding newlines. Returns the mutated byte offset so tests
 * can assert the file actually changed.
 */
function mutateLineContaining(file: string, byteStart: number): number {
  const buf = readFileSync(file);
  // Find the line boundaries around byteStart.
  let lineStart = byteStart;
  while (lineStart > 0 && buf[lineStart - 1] !== 0x0a) lineStart--;
  let lineEnd = byteStart;
  while (lineEnd < buf.length && buf[lineEnd] !== 0x0a) lineEnd++;
  // Pick a byte comfortably inside the line so we never collide with newlines.
  // Target the middle printable character; toggle a bit that keeps it printable.
  const target = Math.max(lineStart, Math.min(lineEnd - 1, lineStart + 5));
  buf[target] = buf[target] ^ 0x01; // flip the low bit → different byte, same length
  writeFileSync(file, buf);
  return target;
}

describe('BUG-7 /api/unmask TOCTOU', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => {
    await h.close();
  });

  test('happy path: unmasks when source is unchanged', async () => {
    const res = await fetch(`${h.baseUrl}/api/unmask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unmask-confirm': '1',
      },
      body: JSON.stringify({ ledgerEntryId: h.ledgerEntryId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { plaintext: string };
    expect(typeof body.plaintext).toBe('string');
  });

  test('returns 409 when the source line has been mutated post-import', async () => {
    const before = readFileSync(h.fixtureFile);
    const mutatedAt = mutateLineContaining(h.fixtureFile, h.byteStart);
    const after = readFileSync(h.fixtureFile);
    // Sanity: we actually wrote a different byte and kept the file the same length.
    expect(after.length).toBe(before.length);
    expect(after[mutatedAt]).not.toBe(before[mutatedAt]);

    const res = await fetch(`${h.baseUrl}/api/unmask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unmask-confirm': '1',
      },
      body: JSON.stringify({ ledgerEntryId: h.ledgerEntryId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('source changed');
  });
});
