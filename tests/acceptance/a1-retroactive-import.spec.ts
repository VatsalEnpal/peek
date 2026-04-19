// Karpathy A1 — immutable. DO NOT edit during overnight /loop run.
// Protected by protect-files.sh (tests/acceptance/**).
import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256OfDirectory, importFromDirectory, countImportedSessions } from './helpers';

describe('A1: retroactive import does not modify source', () => {
  beforeEach(() => {
    process.env.PEEK_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'peek-test-'));
  });

  test('imports isolated fixture dir without touching source files', async () => {
    const FIXTURE_DIR = './tests/fixtures/isolated-claude-projects/';

    const sourceHashBefore = sha256OfDirectory(FIXTURE_DIR);
    await importFromDirectory(FIXTURE_DIR);
    const sourceHashAfter = sha256OfDirectory(FIXTURE_DIR);

    expect(sourceHashAfter, 'source directory MUST be byte-identical after import').toEqual(
      sourceHashBefore
    );

    const imported = await countImportedSessions();
    expect(imported, 'at least one session must have been imported').toBeGreaterThan(0);

    rmSync(process.env.PEEK_TEST_DATA_DIR!, { recursive: true, force: true });
  });
});
