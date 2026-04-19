/**
 * Integration: `peek serve --watch` and bare `peek` both boot a combined
 * watcher + HTTP server and print a recognisable startup line.
 *
 * We spawn the CLI with the locally installed `tsx` runner, wait for the
 * first line on stdout, then SIGTERM it. Asserts are string-based on the
 * startup banner — enough to confirm L1.4 wiring without a full E2E.
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
        // Give it 100ms to exit cleanly — we don't block the test on it.
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

describe('peek CLI — serve + watch wiring (L1.4)', () => {
  test('peek serve --watch prints "serving ... watch=<dir>" banner', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-cli-sw-data-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'peek-cli-sw-claude-'));
    try {
      const line = await awaitFirstLine(
        [
          'serve',
          '--port',
          '0',
          '--data-dir',
          dataDir,
          '--watch',
          '--claude-dir',
          claudeDir,
        ],
        {}
      );
      expect(line).toMatch(/peek serving on http:\/\/localhost:\d+/);
      expect(line).toContain(`watch=${claudeDir}`);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test('bare `peek` (no args) honors $PEEK_PORT and prints "peek live on" banner', async () => {
    // We point HOME at a tmp dir so the default dataDir / claudeDir both
    // land inside it — keeps the test hermetic.
    const fakeHome = mkdtempSync(join(tmpdir(), 'peek-cli-bare-home-'));
    try {
      const line = await awaitFirstLine([], {
        HOME: fakeHome,
        PEEK_PORT: '0',
      });
      expect(line).toMatch(/peek live on http:\/\/localhost:\d+/);
      expect(line).toContain(`watch=${join(fakeHome, '.claude', 'projects')}`);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
