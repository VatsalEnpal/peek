/**
 * Integration: launch-path defaults for `peek serve`.
 *
 * Regression coverage for the v0.3 pre-launch audit:
 *   - Port default must be 7335 everywhere (slash commands target 7335).
 *     Previously `peek serve` defaulted to 7334 → first-time users got
 *     "daemon not running" from the slash command.
 *   - `peek serve` must honor `PEEK_PORT` and `PEEK_DATA_DIR` env vars.
 *     Previously only the `-p`/`-d` flags worked; the slash-command
 *     bodies honored `$PEEK_PORT`, so users had env-var-vs-flag asymmetry.
 *   - `peek serve` must run the watcher by default. Previously `--watch`
 *     had to be passed explicitly, so a user running `peek serve` never
 *     saw new Claude Code activity show up in the UI.
 *   - `peek serve --no-watch` must disable the watcher (escape hatch).
 *
 * Tests spawn the CLI via `tsx`, read the startup banner's first stdout
 * line, then SIGTERM. No HTTP round-trip — the banner itself carries the
 * bound host/port, dataDir, and watch path.
 */

import { describe, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(REPO_ROOT, 'bin', 'peek.ts');

function awaitFirstLine(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 8000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        reject(new Error(`timeout; stdout=${JSON.stringify(stdout)}`));
      }
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
      const idx = stdout.indexOf('\n');
      if (idx !== -1 && !resolved) {
        resolved = true;
        clearTimeout(timer);
        const line = stdout.slice(0, idx);
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 300);
        resolve(line);
      }
    });
    child.on('error', reject);
  });
}

describe('peek serve — launch-path defaults (v0.3 audit)', () => {
  test('peek serve (no flags) defaults to port 7335 (matches slash-command default)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-def-port-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-def-claude-'));
    try {
      // No --port flag, no PEEK_PORT env — reaching for the unadorned default.
      const line = await awaitFirstLine(
        ['serve', '--data-dir', dataDir, '--claude-dir', claudeDir],
        {}
      );
      expect(line).toMatch(/peek live on http:\/\/127\.0\.0\.1:7335\b/);
      expect(line).not.toMatch(/:7334\b/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test('peek serve honors $PEEK_PORT when no -p flag given', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-envport-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-envclaude-'));
    try {
      const line = await awaitFirstLine(
        ['serve', '--data-dir', dataDir, '--claude-dir', claudeDir],
        { PEEK_PORT: '7377' }
      );
      expect(line).toMatch(/peek live on http:\/\/127\.0\.0\.1:7377\b/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test('peek serve honors $PEEK_DATA_DIR when no -d flag given', async () => {
    const envDataDir = mkdtempSync(join(tmpdir(), 'peek-cli-envdata-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-envdata-claude-'));
    try {
      const line = await awaitFirstLine(
        ['serve', '--port', '0', '--claude-dir', claudeDir],
        { PEEK_DATA_DIR: envDataDir }
      );
      // Banner format: `peek live on http://HOST:PORT (dataDir=..., watch=...)`
      expect(line).toContain(`dataDir=${envDataDir}`);
    } finally {
      rmSync(envDataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test('peek serve (no flags) starts the watcher by default', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-defwatch-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-defwatch-claude-'));
    try {
      const line = await awaitFirstLine(
        ['serve', '--port', '0', '--data-dir', dataDir, '--claude-dir', claudeDir],
        {}
      );
      // Banner must include the `watch=<claudeDir>` segment when the watcher is active.
      expect(line).toContain(`watch=${claudeDir}`);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test('peek serve --no-watch disables the watcher (escape hatch)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-nowatch-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-nowatch-claude-'));
    try {
      const line = await awaitFirstLine(
        [
          'serve',
          '--port',
          '0',
          '--data-dir',
          dataDir,
          '--no-watch',
          '--claude-dir',
          claudeDir,
        ],
        {}
      );
      // Banner must NOT include the `watch=` segment when --no-watch is passed.
      expect(line).not.toContain('watch=');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});
