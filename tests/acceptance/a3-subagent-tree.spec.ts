// Karpathy A3 — subagent sidecars correctly attributed to parent Task span.
// See A2 for fixture conventions: drop a real CC session at real-session.jsonl to run locally.
import { describe, test, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFixture, sumChildTokens } from './helpers';

const FIXTURE_PATH = './tests/fixtures/isolated-claude-projects/real-session.jsonl';
const HAS_FIXTURE = existsSync(FIXTURE_PATH);

describe.skipIf(!HAS_FIXTURE)('A3: subagent sidecars correctly attributed to parent Task span', () => {
  beforeEach(() => {
    process.env.PEEK_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'peek-test-'));
  });

  test('nested subagent transcripts accounted for under parent Task span within 0.5%', async () => {
    const session = await importFixture(FIXTURE_PATH);
    expect(session.spans).toBeDefined();

    const taskSpans = session.spans.filter((s: any) => s.type === 'subagent');

    // If the dropped fixture has no subagent spawns, the test is vacuously true.
    // For meaningful A3 coverage, use a session that includes at least one Task
    // subagent spawn (any orchestrator-style session with dispatched subagents).
    if (taskSpans.length === 0) {
      console.warn(
        'A3: fixture contains no subagent spans — cannot verify tree attribution. Consider a fixture with nested Task calls.'
      );
      return;
    }

    for (const task of taskSpans) {
      const reportedTotal = task.metadata?.reportedTotalTokens;
      if (reportedTotal == null) continue;
      expect(
        task.childSpanIds?.length ?? 0,
        `subagent span ${task.id} has no children — sidecar missing?`
      ).toBeGreaterThan(0);
      const childSum = sumChildTokens(task, session);
      const drift = Math.abs(childSum - reportedTotal) / reportedTotal;
      expect(
        drift,
        `subagent ${task.id}: child-sum=${childSum} vs reported=${reportedTotal} drift=${(drift * 100).toFixed(3)}%`
      ).toBeLessThan(0.005);
    }

    rmSync(process.env.PEEK_TEST_DATA_DIR!, { recursive: true, force: true });
  });
});
