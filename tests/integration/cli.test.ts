/**
 * Integration tests for the `peek` CLI (Task 7.1).
 *
 * Each test spawns `bin/peek.ts` via the locally installed `tsx` runner. We
 * avoid `npx` to keep the test fully hermetic — the `tsx` binary is a
 * devDependency and therefore always present after `npm install`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'peek.ts');

function runCli(
  args: string[],
  env: Record<string, string> = {}
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const res = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status,
  };
}

describe('peek CLI', () => {
  let tmpRoot: string;
  let fixtureFile: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'peek-cli-test-'));
    fixtureFile = join(tmpRoot, 'tiny.jsonl');

    // Tiny synthetic JSONL: one user prompt + one assistant reply.
    const events = [
      {
        type: 'user',
        uuid: 'cli-u-1',
        sessionId: 'cli-session-1',
        cwd: '/tmp/cli',
        gitBranch: 'main',
        version: '1.0.0',
        entrypoint: 'cli',
        timestamp: '2026-04-18T09:00:00Z',
        message: { role: 'user', content: 'hello from cli test' },
      },
      {
        type: 'assistant',
        uuid: 'cli-a-1',
        parentUuid: 'cli-u-1',
        sessionId: 'cli-session-1',
        timestamp: '2026-04-18T09:00:01Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hi back' }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 5,
          },
        },
      },
    ];
    writeFileSync(fixtureFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('--help prints usage with all subcommands', () => {
    const { stdout, status } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('peek');
    expect(stdout).toContain('serve');
    expect(stdout).toContain('import');
    expect(stdout).toContain('verify');
    expect(stdout).toContain('bookmarks');
  });

  test('--version prints package.json version', () => {
    const { stdout, status } = runCli(['--version']);
    expect(status).toBe(0);
    // package.json version is 0.0.1 at time of writing — assert shape, not
    // exact literal, so a future bump doesn't silently break this test.
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('import <file> --preview prints JSON with sessionCount:1', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-data-'));
    try {
      const { stdout, status } = runCli([
        'import',
        fixtureFile,
        '--preview',
        '--data-dir',
        dataDir,
      ]);
      expect(status).toBe(0);

      // Pull the JSON line out (action may print other log lines; take last JSON-ish line).
      const line =
        stdout
          .trim()
          .split('\n')
          .reverse()
          .find((l) => l.trim().startsWith('{')) ?? '';
      const parsed = JSON.parse(line);
      expect(parsed.preview).toBe(true);
      expect(parsed.sessionCount).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('serve --help prints serve subcommand usage', () => {
    const { stdout, status } = runCli(['serve', '--help']);
    expect(status).toBe(0);
    expect(stdout.toLowerCase()).toContain('port');
  });

  test('bookmarks list runs against an empty data dir and prints []', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-bm-'));
    try {
      const { stdout, status } = runCli(['bookmarks', 'list', '--data-dir', dataDir]);
      expect(status).toBe(0);
      // Should be valid JSON; an empty store yields [].
      const line =
        stdout
          .trim()
          .split('\n')
          .reverse()
          .find((l) => l.trim().startsWith('[')) ?? '';
      const parsed = JSON.parse(line);
      expect(Array.isArray(parsed)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
