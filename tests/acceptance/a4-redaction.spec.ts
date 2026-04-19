// Karpathy A4 — immutable. DO NOT edit during overnight /loop run.
import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFixture, readDbAsText } from './helpers';

describe('A4: secrets redacted at capture, plaintext never stored, deterministic within session', () => {
  beforeEach(() => {
    process.env.PEEK_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'peek-test-'));
  });

  test('redaction catches known secret patterns and produces identical hashes for same secret within session', async () => {
    await importFixture('./tests/fixtures/session-with-secrets.jsonl');
    const dbText = await readDbAsText();

    // No plaintext
    expect(dbText, 'Anthropic key must not appear plaintext in DB').not.toContain(
      'sk-ant-api03-TEST-SECRET-ABCDEFGHIJ1234567890abcdefghij012345'
    );
    expect(dbText, 'AWS key must not appear plaintext in DB').not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(dbText, 'env-var heuristic value must not appear plaintext').not.toContain(
      'sk-foo-bar-baz-not-matching-standard-pattern-1234567890'
    );

    // Deterministic: same Anthropic key at two different positions → same hash
    const match1 = dbText.match(/Anthropic key is <secret:([a-f0-9]{8})>/);
    const match2 = dbText.match(/determinism test: <secret:([a-f0-9]{8})>/);
    expect(match1, 'first Anthropic key redaction should produce a hash').toBeTruthy();
    expect(match2, 'second Anthropic key redaction should produce a hash').toBeTruthy();
    expect(match1![1], 'same secret → same hash within session (deterministic)').toEqual(
      match2![1]
    );

    rmSync(process.env.PEEK_TEST_DATA_DIR!, { recursive: true, force: true });
  });
});
