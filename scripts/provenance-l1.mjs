#!/usr/bin/env node
/**
 * Provenance spot-check for L1 (v0.2.1).
 *
 * Writes a synthetic 3-event JSONL with an exact output-tokens count,
 * boots `startServe({watch:true})`, waits for the importer to land the
 * session + span + marker in the store, then greps the raw sqlite dump
 * for the exact numbers that were written. Fails non-zero if anything
 * doesn't line up.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { startServe } = await import('../server/cli/serve.ts');
const { Store } = await import('../server/pipeline/store.ts');

const dataDir = mkdtempSync(join(tmpdir(), 'peek-prov-data-'));
const claudeDir = mkdtempSync(join(tmpdir(), 'peek-prov-claude-'));

// Three chosen-for-uniqueness numbers we will later grep for.
const UNIQUE_OUTPUT_TOKENS = 73317;
const UNIQUE_INPUT_TOKENS = 42419;
const UNIQUE_CACHE_CREATE = 99119;

const events = [
  {
    type: 'user',
    uuid: 'prov-u-1',
    sessionId: 'prov-session-xyz',
    cwd: '/tmp/prov',
    gitBranch: 'main',
    version: '1.0.0',
    entrypoint: 'cli',
    timestamp: '2026-04-19T22:00:00Z',
    message: { role: 'user', content: 'kick off the run' },
  },
  {
    type: 'assistant',
    uuid: 'prov-a-1',
    parentUuid: 'prov-u-1',
    sessionId: 'prov-session-xyz',
    timestamp: '2026-04-19T22:00:01Z',
    message: {
      role: 'assistant',
      id: 'msg-prov-1',
      model: 'claude-opus-4-7',
      content: [
        {
          type: 'tool_use',
          id: 'toolu-prov-1',
          name: 'Bash',
          input: { command: 'ls /tmp' },
        },
      ],
      usage: {
        input_tokens: UNIQUE_INPUT_TOKENS,
        output_tokens: UNIQUE_OUTPUT_TOKENS,
        cache_creation_input_tokens: UNIQUE_CACHE_CREATE,
        cache_read_input_tokens: 0,
      },
    },
  },
  {
    type: 'user',
    uuid: 'prov-u-2',
    parentUuid: 'prov-a-1',
    sessionId: 'prov-session-xyz',
    timestamp: '2026-04-19T22:00:10Z',
    message: { role: 'user', content: '/peek_start provenance-check' },
  },
];

const projectDir = join(claudeDir, 'prov-project');
mkdirSync(projectDir, { recursive: true });
const jsonl = join(projectDir, 'prov-session-xyz.jsonl');
writeFileSync(jsonl, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log('[prov] wrote jsonl', jsonl);

const handle = await startServe({ dataDir, port: 0, watch: true, claudeDir });
console.log('[prov] serve up on port', handle.port);

function waitFor(fn, timeoutMs = 5000, interval = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        const v = fn();
        if (v !== undefined && v !== null && v !== false) return resolve(v);
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(check, interval);
    };
    check();
  });
}

function fail(msg) {
  console.error('[prov] FAIL:', msg);
  process.exitCode = 1;
}

try {
  // Poll for session row.
  await waitFor(() => {
    const s = new Store(dataDir);
    try {
      const rows = s.db
        .prepare('SELECT id FROM sessions WHERE id = ?')
        .all('prov-session-xyz');
      return rows.length > 0 ? true : undefined;
    } finally {
      s.close();
    }
  });
  console.log('[prov] session present in store');

  // Poll for span.
  await waitFor(() => {
    const s = new Store(dataDir);
    try {
      const spans = s.db
        .prepare('SELECT type, name, tokens_consumed FROM action_spans WHERE session_id = ?')
        .all('prov-session-xyz');
      return spans.length >= 1 ? spans : undefined;
    } finally {
      s.close();
    }
  });
  console.log('[prov] spans present in store');

  // Poll for marker bookmark (from /peek_start detection in importer).
  await waitFor(() => {
    const s = new Store(dataDir);
    try {
      const bms = s.listBookmarks('prov-session-xyz');
      const marker = bms.find(
        (b) => b.source === 'marker' && b.label === 'provenance-check'
      );
      return marker ?? undefined;
    } finally {
      s.close();
    }
  });
  console.log('[prov] marker bookmark present in store');

  // Dump the sqlite DB as text and grep for the exact numbers.
  const dump = spawnSync('sqlite3', [join(dataDir, 'store.db'), '.dump'], {
    encoding: 'utf8',
  });
  if (dump.status !== 0) {
    console.error('[prov] sqlite3 .dump failed:', dump.stderr);
    process.exit(1);
  }
  const raw = dump.stdout;
  const numbersToCheck = [UNIQUE_OUTPUT_TOKENS, UNIQUE_INPUT_TOKENS, UNIQUE_CACHE_CREATE];
  for (const n of numbersToCheck) {
    if (!raw.includes(String(n))) {
      fail(`expected ${n} in DB dump, not found`);
    } else {
      console.log(`[prov] ok — DB dump contains ${n}`);
    }
  }

  // Also show the line(s) where they show up.
  for (const n of numbersToCheck) {
    const lines = raw.split('\n').filter((l) => l.includes(String(n)));
    for (const l of lines.slice(0, 2)) console.log(`[prov]   [${n}] → ${l.slice(0, 200)}`);
  }
} finally {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('[prov] overall: FAIL');
  process.exit(process.exitCode);
}
console.log('[prov] overall: PASS');
