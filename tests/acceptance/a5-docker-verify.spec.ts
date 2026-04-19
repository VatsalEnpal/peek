// Karpathy A5 — immutable. DO NOT edit during overnight /loop run.
// SCOPED to deterministic fixture-verify in Docker. Live-CC-in-Docker deferred to v0.1.1.
import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dockerBuild, dockerRun } from './helpers';

// Genuinely skip (not falsely pass) when Docker prereqs absent.
const SKIP = process.env.SKIP_DOCKER_TESTS === '1' || !existsSync('docker/Dockerfile.verify');

describe.skipIf(SKIP)(
  'A5: fresh Docker container imports fixture and verifies token counts',
  () => {
    test('peek CLI inside Docker imports fixtures and passes verify', async () => {
      await dockerBuild('docker/Dockerfile.verify');
      const result = await dockerRun({
        cmd: [
          'peek',
          'import',
          '/fixtures/isolated-claude-projects/',
          '&&',
          'peek',
          'verify',
          '/fixtures/expected-counts.json',
        ],
        volumes: {
          'tests/fixtures/isolated-claude-projects': '/fixtures/isolated-claude-projects:ro',
          'tests/fixtures/expected-counts.json': '/fixtures/expected-counts.json:ro',
        },
      });

      expect(
        result.exitCode,
        `Docker verify must exit 0. stdout: ${result.stdout}\nstderr: ${result.stderr}`
      ).toBe(0);
      expect(result.stdout).toMatch(/import-success: \d+ sessions/);
      expect(result.stdout).toMatch(/token-drift: 0\.\d+% \(< 0\.5% threshold\)/);
    }, 300_000);
  }
);
