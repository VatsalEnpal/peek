/**
 * Integration tests for server/pipeline/import.ts — the pipeline orchestrator
 * that wires parser -> joiner -> model -> tokenizer -> redactor -> store.
 *
 * These tests use a tiny synthetic JSONL fixture (written to mkdtempSync) for
 * fast, deterministic coverage and also exercise the real biz-ops-real.jsonl
 * fixture read-only so we prove the orchestrator works end-to-end on realistic
 * data. The real fixture is NEVER written to: we verify source byte-identity
 * with a hash check (mirrors the A1 acceptance contract).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { importPath } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';

const REAL_FIXTURE = './tests/fixtures/isolated-claude-projects/biz-ops-real.jsonl';

function makeTinyJsonl(): string {
  const events = [
    {
      type: 'user',
      uuid: 'u-1',
      sessionId: 'tiny-session-1',
      cwd: '/tmp/tiny',
      gitBranch: 'main',
      version: '1.0.0',
      entrypoint: 'cli',
      timestamp: '2026-04-18T10:00:00Z',
      message: { role: 'user', content: 'hello there, assistant' },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      parentUuid: 'u-1',
      sessionId: 'tiny-session-1',
      timestamp: '2026-04-18T10:00:01Z',
      message: {
        role: 'assistant',
        id: 'msg-001',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hi — how can I help today?' }],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('importPath orchestrator', () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-import-test-'));
    dataDir = mkdtempSync(join(tmpdir(), 'peek-import-data-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('imports a synthetic jsonl file end-to-end: turns, spans, ledger, tokens', async () => {
    const file = join(tmpDir, 'tiny.jsonl');
    writeFileSync(file, makeTinyJsonl());

    const session: any = await importPath(file, { dataDir, returnAssembled: true });

    expect(session, 'returned value must be defined').toBeDefined();
    expect(session.id).toBe('tiny-session-1');
    expect(Array.isArray(session.turns)).toBe(true);
    expect(session.turns.length).toBeGreaterThan(0);
    expect(Array.isArray(session.spans)).toBe(true);
    expect(session.spans.length).toBeGreaterThan(0);
    expect(Array.isArray(session.ledger)).toBe(true);
    expect(session.ledger.length).toBeGreaterThan(0);

    // camelCase assertion: no snake_case on turn.usage
    const turn = session.turns[0];
    expect(turn.usage).toBeDefined();
    expect(turn.usage.inputTokens).toBeDefined();
    expect((turn.usage as any).input_tokens).toBeUndefined();
    expect((turn.usage as any).output_tokens).toBeUndefined();

    // Tokens should be non-zero for non-empty content.
    const totalLedgerTokens = session.ledger.reduce((s: number, l: any) => s + (l.tokens ?? 0), 0);
    expect(totalLedgerTokens).toBeGreaterThan(0);
  });

  test('preview mode returns counts but does NOT write to the store', async () => {
    const file = join(tmpDir, 'tiny.jsonl');
    writeFileSync(file, makeTinyJsonl());

    const result: any = await importPath(file, { dataDir, preview: true });

    expect(result.preview).toBe(true);
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].turnCount).toBeGreaterThan(0);

    // DB should have no rows (store was not populated). The DB file may or
    // may not exist depending on whether the Store constructor ran, but
    // listSessions() must be empty either way.
    const dbPath = join(dataDir, 'store.db');
    if (existsSync(dbPath)) {
      const store = new Store(dbPath);
      expect(store.listSessions().length).toBe(0);
      store.close();
    }
  });

  test('preview then commit is idempotent (second commit replaces first)', async () => {
    const file = join(tmpDir, 'tiny.jsonl');
    writeFileSync(file, makeTinyJsonl());

    // Preview
    const previewResult: any = await importPath(file, { dataDir, preview: true });
    expect(previewResult.preview).toBe(true);

    // Commit
    await importPath(file, { dataDir });
    const store1 = new Store(dataDir);
    const sessionsAfterFirst = store1.listSessions();
    expect(sessionsAfterFirst.length).toBe(1);
    store1.close();

    // Commit again — idempotent via INSERT OR REPLACE
    await importPath(file, { dataDir });
    const store2 = new Store(dataDir);
    const sessionsAfterSecond = store2.listSessions();
    expect(sessionsAfterSecond.length).toBe(1);
    expect(sessionsAfterSecond[0].id).toBe(sessionsAfterFirst[0].id);
    store2.close();
  });

  test('returnAssembled:true returns a Session; default returns ImportResult', async () => {
    const file = join(tmpDir, 'tiny.jsonl');
    writeFileSync(file, makeTinyJsonl());

    const assembled: any = await importPath(file, { dataDir, returnAssembled: true });
    expect(assembled).toBeDefined();
    // Session has id + turns + spans + ledger
    expect(typeof assembled.id).toBe('string');
    expect(Array.isArray(assembled.turns)).toBe(true);
    // ImportResult has sessions array — Session does NOT
    expect((assembled as any).sessions).toBeUndefined();

    const result: any = await importPath(file, { dataDir });
    expect(result).toBeDefined();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.preview).toBe('boolean');
    expect(result.preview).toBe(false);
    expect(Array.isArray(result.driftWarnings)).toBe(true);
  });

  test('imports the real biz-ops-real.jsonl fixture without modifying it', async () => {
    expect(existsSync(REAL_FIXTURE), `real fixture must exist at ${REAL_FIXTURE}`).toBe(true);

    const before = hashFile(REAL_FIXTURE);
    const session: any = await importPath(REAL_FIXTURE, { dataDir, returnAssembled: true });
    const after = hashFile(REAL_FIXTURE);

    // Source byte-identical
    expect(after, 'source fixture must be byte-identical after import').toEqual(before);

    // Session hydrated with real content
    expect(session).toBeDefined();
    expect(session.turns.length).toBeGreaterThan(0);
    expect(session.spans.length).toBeGreaterThan(0);
    expect(session.ledger.length).toBeGreaterThan(0);

    // Store has at least one session after import
    const store = new Store(dataDir);
    const sessions = store.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    store.close();
  }, 120_000);

  test('directory import walks *.jsonl files as separate sessions', async () => {
    writeFileSync(join(tmpDir, 'a.jsonl'), makeTinyJsonl());
    // Second file with a different sessionId to avoid dedupe collapse.
    const alt = makeTinyJsonl().replace(/tiny-session-1/g, 'tiny-session-2');
    writeFileSync(join(tmpDir, 'b.jsonl'), alt);
    // A non-jsonl file that must be ignored.
    writeFileSync(join(tmpDir, 'README.md'), 'not jsonl');

    const result: any = await importPath(tmpDir, { dataDir });
    expect(result.sessions.length).toBe(2);

    const store = new Store(dataDir);
    const ids = store
      .listSessions()
      .map((s) => s.id)
      .sort();
    store.close();
    expect(ids).toEqual(['tiny-session-1', 'tiny-session-2']);
  });
});

describe('Store.dumpAsText()', () => {
  let dataDir: string;
  let tmpDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'peek-dump-data-'));
    tmpDir = mkdtempSync(join(tmpdir(), 'peek-dump-src-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('concatenates stored text so redaction markers are greppable', async () => {
    const file = join(tmpDir, 'tiny.jsonl');
    writeFileSync(file, makeTinyJsonl());

    await importPath(file, { dataDir });

    const store = new Store(dataDir);
    const text = store.dumpAsText();
    store.close();

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // The user prompt body should be recoverable from the dump.
    expect(text).toContain('hello there, assistant');
  });
});
