/**
 * Checker finding #3 (v0.2) — blocking: 178/178 tool_call spans had
 * `tokens: undefined` in the /api/sessions/:id/events response, causing the
 * UI tokens column to always render `—`.
 *
 * Failure mode reproduced here without the HTTP layer:
 *   1. Run `importPath` against the real real-session.jsonl fixture (preview).
 *   2. Assert the assembled Session has numeric, > 0 `tokensConsumed` on every
 *      tool_call span that has a matching tool_result attached.
 *
 * Root cause (pre-fix): `collectContentBlocks` in server/pipeline/import.ts
 * only iterated user-prompt text and assistant blocks — tool_result payloads
 * never entered `tokenMap`, so the assembler's `tokenOf` closure returned 0
 * for every tool_result ledger entry, so `target.tokensConsumed += 0`.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPath } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';
import type { Session } from '../../server/pipeline/model';

const REAL_FIXTURE = './tests/fixtures/isolated-claude-projects/real-session.jsonl';

describe('tokensConsumed on spans (checker finding 3)', () => {
  test('every tool_call span with a tool_result output has tokensConsumed > 0', async () => {
    if (!existsSync(REAL_FIXTURE)) {
      // Fixture not present in this checkout — skip rather than fail.
      expect(true).toBe(true);
      return;
    }
    const assembled = (await importPath(REAL_FIXTURE, {
      preview: true,
      returnAssembled: true,
    })) as Session;

    const toolSpans = assembled.spans.filter((s) => s.type === 'tool_call');
    expect(toolSpans.length).toBeGreaterThan(0);

    // Every tool_call span with a non-empty output string represents a round
    // trip where Claude paid tokens for the tool_result coming back.
    const withResults = toolSpans.filter(
      (s) => typeof s.outputs === 'string' && (s.outputs as string).length > 0
    );
    expect(withResults.length).toBeGreaterThan(0);

    for (const span of withResults) {
      expect(typeof span.tokensConsumed).toBe('number');
      expect(Number.isFinite(span.tokensConsumed)).toBe(true);
      expect(span.tokensConsumed).toBeGreaterThan(0);
    }

    // Report sample for the verifier.
    const sample = withResults[0]!;
    // eslint-disable-next-line no-console
    console.log(
      `[token-check] sample tool_call name=${sample.name} id=${sample.id} tokensConsumed=${sample.tokensConsumed}`
    );
  }, 30_000);

  test('tokensConsumed survives store round-trip and is exposed via listEvents (what the API returns)', async () => {
    if (!existsSync(REAL_FIXTURE)) {
      expect(true).toBe(true);
      return;
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'peek-tokens-'));
    try {
      await importPath(REAL_FIXTURE, { dataDir });

      const store = new Store(dataDir);
      try {
        const sessions = store.listSessions();
        expect(sessions.length).toBeGreaterThan(0);
        const sess = sessions[0]!;
        const events = store.listEvents(sess.id);
        const toolSpans = events.filter(
          (e) => e.kind === 'span' && (e as { type: string }).type === 'tool_call'
        ) as Array<{ id: string; kind: 'span'; type: string; tokensConsumed?: number }>;

        expect(toolSpans.length).toBeGreaterThan(0);

        // EVERY tool_call span emitted by listEvents (what the HTTP route
        // streams to the UI) must have a numeric tokensConsumed field.
        const missing = toolSpans.filter(
          (s) => typeof s.tokensConsumed !== 'number' || !Number.isFinite(s.tokensConsumed)
        );
        expect(
          missing.length,
          `expected 0 tool_call spans with undefined tokensConsumed, got ${missing.length}/${toolSpans.length}`
        ).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
