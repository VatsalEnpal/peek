#!/usr/bin/env node
/**
 * `peek` CLI entry point — Task 7.1.
 *
 * Uses `commander` for argument parsing. All subcommands are thin glue over
 * the existing server/pipeline modules:
 *
 *   - `peek serve`     → `createServer({ dataDir, port })` then listen.
 *   - `peek import`    → `importPath(path, { preview, dataDir })`.
 *   - `peek verify`    → re-imports the session referenced by expected-counts.json
 *                        and compares the summed output-token total against the
 *                        expected value (within a 2% tolerance).
 *   - `peek bookmarks list` → `new Store(dataDir).listBookmarks()` as JSON.
 *
 * Default dataDir is `$HOME/.peek`. The shebang on line 1 makes the compiled
 * `dist/bin/peek.js` directly executable when installed via the package `bin`
 * field.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';

import { createServer } from '../server/index';
import { importPath, type ImportResult } from '../server/pipeline/import';
import { Store } from '../server/pipeline/store';

function defaultDataDir(): string {
  return path.join(os.homedir(), '.peek');
}

function readPkgVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('peek')
  .description('Local trace viewer for Claude Code sessions')
  .version(readPkgVersion());

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Start the Peek HTTP server')
  .option('-p, --port <port>', 'port to listen on', '7334')
  .option('-d, --data-dir <dir>', 'data directory', defaultDataDir())
  .action(async (opts: { port: string; dataDir: string }) => {
    const port = parseInt(opts.port, 10);
    const handle = createServer({ dataDir: opts.dataDir, port });
    await handle.listen();
    // eslint-disable-next-line no-console
    console.log(`peek serving on http://localhost:${port} (dataDir=${opts.dataDir})`);
  });

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

program
  .command('import <path>')
  .description('Import JSONL sessions from a file or directory')
  .option('--preview', 'scan without writing to the store', false)
  .option('-d, --data-dir <dir>', 'data directory', defaultDataDir())
  .action(async (srcPath: string, opts: { preview: boolean; dataDir: string }) => {
    const result = (await importPath(srcPath, {
      dataDir: opts.dataDir,
      preview: !!opts.preview,
    })) as ImportResult;

    const sessionCount = result.sessions?.length ?? 0;
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        preview: result.preview === true,
        sessionCount,
        sessions: result.sessions ?? [],
      })
    );
  });

// ---------------------------------------------------------------------------
// verify
//
// Minimum-viable token-accuracy gate: re-import the referenced fixture, sum
// the assistant turn `outputTokens` totals, and compare against
// `expected-counts.json::sumOutputTokens`. Drift under 2% => exit 0.
// ---------------------------------------------------------------------------

program
  .command('verify <expectedJson>')
  .description('Verify token accuracy against an expected-counts.json')
  .option('-d, --data-dir <dir>', 'data directory', defaultDataDir())
  .option(
    '--fixture <path>',
    'override fixture path (default: resolve `source` sibling to expectedJson)'
  )
  .action(async (expectedJson: string, opts: { dataDir: string; fixture?: string }) => {
    const expectedRaw = readFileSync(expectedJson, 'utf8');
    const expected = JSON.parse(expectedRaw) as {
      source?: string;
      sumOutputTokens?: number;
    };

    const expectedSum = Number(expected.sumOutputTokens ?? 0);
    if (!Number.isFinite(expectedSum) || expectedSum <= 0) {
      // eslint-disable-next-line no-console
      console.error('verify: expected-counts.json missing positive sumOutputTokens');
      process.exit(1);
    }

    const fixturePath = (() => {
      if (opts.fixture) return path.resolve(opts.fixture);
      const src = expected.source ?? '';
      return path.resolve(path.dirname(expectedJson), src);
    })();

    const result = (await importPath(fixturePath, {
      dataDir: opts.dataDir,
      preview: true,
    })) as ImportResult;

    // Sum outputTokens across all assembled sessions' turns. The import
    // orchestrator surfaces `turnCount` + `totalTokens` (ledger), but the
    // verify gate is specifically about assistant usage output — so re-
    // import with returnAssembled and walk turns.
    const assembled = (await importPath(fixturePath, {
      dataDir: opts.dataDir,
      preview: true,
      returnAssembled: true,
    })) as unknown as { turns?: Array<{ usage?: { outputTokens?: number } }> };

    const actualSum = (assembled.turns ?? []).reduce((s, t) => s + (t.usage?.outputTokens ?? 0), 0);

    const drift = Math.abs(actualSum - expectedSum) / expectedSum;
    const driftPct = (drift * 100).toFixed(2);
    const threshold = 0.02; // 2%

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        expectedSum,
        actualSum,
        driftPct: Number(driftPct),
        thresholdPct: threshold * 100,
        sessionCount: result.sessions?.length ?? 0,
      })
    );

    if (drift <= threshold) {
      // eslint-disable-next-line no-console
      console.log(`token-drift: ${driftPct}% (<= ${(threshold * 100).toFixed(1)}% threshold)`);
      process.exit(0);
    } else {
      // eslint-disable-next-line no-console
      console.error(`token-drift: ${driftPct}% exceeds ${(threshold * 100).toFixed(1)}% threshold`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// bookmarks list
// ---------------------------------------------------------------------------

const bookmarks = program.command('bookmarks').description('Bookmark management');

bookmarks
  .command('list')
  .description('List all bookmarks in the store as JSON')
  .option('-d, --data-dir <dir>', 'data directory', defaultDataDir())
  .action((opts: { dataDir: string }) => {
    const store = new Store(opts.dataDir);
    try {
      const bms = store.listBookmarks();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(bms, null, 2));
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
