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

import { importPath, type ImportResult } from '../server/pipeline/import';
import { Store } from '../server/pipeline/store';
import { startServe, defaultClaudeDir } from '../server/cli/serve';
import {
  runInstall,
  probeDaemon,
  defaultSkillsSourceDir,
  defaultClaudeConfigDir,
} from '../server/cli/install';

function defaultDataDir(): string {
  return path.join(os.homedir(), '.peek');
}

/**
 * Live-mode default port. v0.2.0 used 7334 for `peek serve`; v0.2.1 adds a
 * bare `peek` entry point on 7335 that co-hosts the watcher. `$PEEK_PORT`
 * wins over both when set.
 */
const LIVE_DEFAULT_PORT = 7335;

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
  .option('--watch', 'also run the JSONL file watcher alongside the server', false)
  .option('--claude-dir <dir>', 'directory watched when --watch is set', defaultClaudeDir())
  .action(
    async (opts: { port: string; dataDir: string; watch: boolean; claudeDir: string }) => {
      const port = parseInt(opts.port, 10);
      const handle = await startServe({
        dataDir: opts.dataDir,
        port,
        watch: !!opts.watch,
        claudeDir: opts.claudeDir,
      });
      // eslint-disable-next-line no-console
      console.log(
        `peek serving on http://localhost:${handle.port} (dataDir=${opts.dataDir}${opts.watch ? `, watch=${opts.claudeDir}` : ''})`
      );
      const shutdown = async (): Promise<void> => {
        await handle.stop();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
  );

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

// ---------------------------------------------------------------------------
// install
//
// Copies the /peek_start and /peek_end slash-command bodies into the user's
// Claude Code config. See `server/cli/install.ts` for layout selection.
// ---------------------------------------------------------------------------

program
  .command('install')
  .description('Install /peek_start and /peek_end slash commands into ~/.claude/')
  .option('--force', 'overwrite existing files', false)
  .option(
    '--target <dir>',
    'install target (default: ~/.claude). Use an explicit path for testing.',
    defaultClaudeConfigDir()
  )
  .option(
    '--skills-source <dir>',
    'directory containing peek_start/SKILL.md and peek_end/SKILL.md (default: bundled)',
    defaultSkillsSourceDir()
  )
  .action(
    async (opts: { force: boolean; target: string; skillsSource: string }) => {
      const result = runInstall({
        claudeDir: opts.target,
        skillsSourceDir: opts.skillsSource,
        force: !!opts.force,
      });

      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error(`peek install: ${result.message ?? 'failed'}`);
        if (result.reason === 'no-claude-dir') {
          // eslint-disable-next-line no-console
          console.error(
            [
              '',
              'Manual install:',
              '  1. Install Claude Code (https://claude.ai/code).',
              '  2. Then run `peek install` again, or copy the files under',
              '     `skills/peek_start/` and `skills/peek_end/` from this repo',
              '     into `~/.claude/commands/peek_start.md` and `peek_end.md`.',
            ].join('\n')
          );
        }
        if (result.reason === 'exists') {
          // eslint-disable-next-line no-console
          console.error('Pass --force to overwrite.');
        }
        process.exit(1);
      }

      // eslint-disable-next-line no-console
      console.log(`peek install: ${result.message ?? 'ok'}`);
      for (const p of result.written ?? []) {
        // eslint-disable-next-line no-console
        console.log(`  wrote: ${p}`);
      }

      // Daemon reachability probe (non-fatal).
      const port = Number(process.env.PEEK_PORT ?? LIVE_DEFAULT_PORT);
      const reachable = await probeDaemon(`http://localhost:${port}`);
      if (!reachable) {
        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log('peek daemon not reachable — run `peek` to start watch + serve.');
      }
      process.exit(0);
    }
  );

// ---------------------------------------------------------------------------
// Bare `peek` — live-mode default. Runs watch + serve on $PEEK_PORT ?? 7335.
// Triggered only when the user passes no subcommand (and no --help / --version
// long options). We detect this by inspecting process.argv before commander
// parses it — commander has no first-class "default command" for zero args
// in v12+ without manipulating the internal state.
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = new Set(['serve', 'import', 'verify', 'bookmarks', 'install', 'help']);
const argsAfterNode = process.argv.slice(2);
const isBare =
  argsAfterNode.length === 0 ||
  (!argsAfterNode[0].startsWith('-') && !KNOWN_COMMANDS.has(argsAfterNode[0]));

if (isBare && argsAfterNode.length === 0) {
  const dataDir = defaultDataDir();
  const claudeDir = defaultClaudeDir();
  const port = Number(process.env.PEEK_PORT ?? LIVE_DEFAULT_PORT);

  void (async (): Promise<void> => {
    try {
      const handle = await startServe({ dataDir, port, watch: true, claudeDir });
      // eslint-disable-next-line no-console
      console.log(
        `peek live on http://localhost:${handle.port} (dataDir=${dataDir}, watch=${claudeDir})`
      );
      const shutdown = async (): Promise<void> => {
        await handle.stop();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
} else {
  program.parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
