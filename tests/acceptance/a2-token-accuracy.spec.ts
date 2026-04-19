// Karpathy A2 — per-block tokens sum to Anthropic reported turn usage within 2%.
// GROUND TRUTH: JSONL's message.usage per turn (what Anthropic reported when CC ran).
// Per-block tokens come from the offline tokenizer; their sum must match per-turn usage within 2%.
// Opt-in 100% per-block via ANTHROPIC_API_KEY (count_tokens API) — not required.
//
// Fixture: drop any real Claude Code session JSONL at the path below to run this
// acceptance test locally. The public repo does not ship a session file; the test
// skips when the fixture is absent. A synthetic session with enough substance
// (at least 5 turns of >100 tokens, some subagent Task spans for A3) works fine.
import { describe, test, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFixture } from './helpers';

const FIXTURE_PATH = './tests/fixtures/isolated-claude-projects/real-session.jsonl';
const HAS_FIXTURE = existsSync(FIXTURE_PATH);

describe.skipIf(!HAS_FIXTURE)('A2: per-block tokens sum to Anthropic reported turn usage within 2%', () => {
  beforeEach(() => {
    process.env.PEEK_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'peek-test-'));
  });

  test('sum of ledger entry tokens per turn matches message.usage within 2%', async () => {
    const session = await importFixture(FIXTURE_PATH);
    expect(session, 'fixture must import').toBeDefined();
    expect(session.turns, 'session must have turns').toBeDefined();
    expect(session.turns.length, 'turns must be non-empty').toBeGreaterThan(0);

    // Take first 10 turns with meaningful usage (skip toy turns).
    // IMPORTANT: Turn.usage is camelCase after assembler (inputTokens etc.) — NOT snake_case from raw JSONL.
    const meaningfulTurns = session.turns
      .filter((t: any) => {
        const u = t?.usage;
        if (!u) return false;
        const total =
          (u.inputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0);
        return total > 100;
      })
      .slice(0, 10);

    expect(
      meaningfulTurns.length,
      'at least 5 meaningful turns needed for sampling'
    ).toBeGreaterThanOrEqual(5);

    for (const turn of meaningfulTurns) {
      const reported =
        turn.usage.inputTokens + turn.usage.cacheCreationTokens + turn.usage.cacheReadTokens;
      const ourSum = session.ledger
        .filter((l: any) => l.turnId === turn.id)
        .reduce((s: number, l: any) => s + (l.tokens ?? 0), 0);

      if (reported === 0) continue;
      const drift = Math.abs(ourSum - reported) / reported;

      // 2% drift threshold: accounts for offline tokenizer variance + internal CC padding (system prompt boilerplate)
      // Tighten to 0.5% if ANTHROPIC_API_KEY is set (API-backed per-block counts = exact)
      const threshold = process.env.ANTHROPIC_API_KEY ? 0.005 : 0.02;

      expect(
        drift,
        `Turn ${turn.index ?? '?'} (${turn.id}): our per-block sum=${ourSum} vs Anthropic reported=${reported}. Drift=${(drift * 100).toFixed(2)}% (threshold ${threshold * 100}%)`
      ).toBeLessThan(threshold);
    }

    rmSync(process.env.PEEK_TEST_DATA_DIR!, { recursive: true, force: true });
  });
});
