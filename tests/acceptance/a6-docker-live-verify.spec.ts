/**
 * A6 — v0.2.1 L5.5 — Docker live-verify acceptance.
 *
 * Purpose: prove the published `peek` tarball + the /peek_start /peek_end
 * slash commands drive bookmarks into the Peek DB when run from a real
 * (headless) Claude Code CLI inside a fresh container. This is the only
 * layer of the test suite that exercises the full distribution path:
 *
 *   host `npm pack` → Dockerfile `npm install -g` → container `peek install`
 *   → container `peek` (bare) → container `claude -p "/peek_start ..."`
 *   → container curl /api/bookmarks asserts label present.
 *
 * Gating:
 *   - Skip when `docker` CLI isn't reachable, i.e. no local daemon.
 *   - Skip when `ANTHROPIC_API_KEY` is not set in the host env. The
 *     Dockerfile's fallback path works without a key but that fallback is
 *     not the thing this acceptance test is measuring — we measure the
 *     real headless-Claude-Code slash-command surface, so no key == SKIP
 *     (not a fake-pass).
 *
 * Runtime budget: the full build + run is ~4-6 minutes cold, dominated by
 * `npm install -g @anthropic-ai/claude-code`. We allow 10 minutes.
 */

import { describe, test, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function dockerInstalled(): boolean {
  const res = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return res.status === 0;
}

const HAS_DOCKER = dockerInstalled();
const HAS_KEY = typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0;
const SKIP = !HAS_DOCKER || !HAS_KEY;

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOCKERFILE = join(REPO_ROOT, 'docker', 'Dockerfile.live-verify');
const IMAGE_TAG = 'peek-live-verify:acceptance';

describe.skipIf(SKIP)('A6: live Docker verify (headless Claude Code + peek install)', () => {
  test(
    'peek install + peek bare + /peek_start inside Docker produces the docker-test bookmark',
    () => {
      expect(existsSync(DOCKERFILE), `Dockerfile missing: ${DOCKERFILE}`).toBe(true);

      const packDir = mkdtempSync(join(tmpdir(), 'peek-live-pack-'));
      try {
        // Build a fresh tarball of the current tree.
        execSync(`npm pack --pack-destination "${packDir}"`, {
          cwd: REPO_ROOT,
          stdio: 'inherit',
        });

        // Copy the tarball into the repo root so Docker sees it in context.
        // We don't move it (keep packDir clean for rm).
        execSync(`cp ${packDir}/peek-trace-*.tgz ${REPO_ROOT}/peek-trace-0.0.1.tgz`, {
          stdio: 'inherit',
        });

        try {
          // Build the image (context = repo root).
          execSync(`docker build -t ${IMAGE_TAG} -f ${DOCKERFILE} ${REPO_ROOT}`, {
            stdio: 'inherit',
          });

          // Run, passing the key through. `--rm` so the container self-cleans.
          const runRes = spawnSync(
            'docker',
            ['run', '--rm', '-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`, IMAGE_TAG],
            { encoding: 'utf8' }
          );

          const combined = `${runRes.stdout ?? ''}\n${runRes.stderr ?? ''}`;
          // eslint-disable-next-line no-console
          console.log('[a6] docker run output:\n' + combined.slice(0, 4000));

          expect(runRes.status, `docker run exited ${runRes.status}; output:\n${combined}`).toBe(0);
          expect(combined).toMatch(/PASS: live Docker verify/);
        } finally {
          // Remove the tarball from repo root but keep the image so subsequent
          // runs are cached.
          try {
            execSync(`rm -f ${REPO_ROOT}/peek-trace-0.0.1.tgz`, { stdio: 'ignore' });
          } catch {
            /* ignore */
          }
        }
      } finally {
        rmSync(packDir, { recursive: true, force: true });
      }
    },
    10 * 60_000
  );
});
