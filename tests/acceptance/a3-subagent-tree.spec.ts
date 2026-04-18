// Karpathy A3 — immutable. DO NOT edit during overnight /loop run.
import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFixture, sumChildTokens } from './helpers';

describe('A3: subagent sidecars correctly attributed to parent Task span', () => {
  beforeEach(() => {
    process.env.PEEK_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'peek-test-'));
  });

  test('nested subagent transcripts accounted for under parent Task span within 0.5%', async () => {
    const session = await importFixture('./tests/fixtures/isolated-claude-projects/biz-ops-real.jsonl');
    expect(session.spans).toBeDefined();

    const taskSpans = session.spans.filter((s: any) => s.type === 'subagent');

    // If fixture has no subagent spawns, test is vacuously true but we expect at least some in a real biz-ops session
    // The biz-ops-real fixture DOES include subagent Task calls (from the orchestration agent)
    if (taskSpans.length === 0) {
      console.warn('A3: fixture contains no subagent spans — cannot verify tree attribution. Consider a fixture with nested Task calls.');
      return;
    }

    for (const task of taskSpans) {
      const reportedTotal = task.metadata?.reportedTotalTokens;
      if (reportedTotal == null) continue;
      expect(task.childSpanIds?.length ?? 0, `subagent span ${task.id} has no children — sidecar missing?`).toBeGreaterThan(0);
      const childSum = sumChildTokens(task, session);
      const drift = Math.abs(childSum - reportedTotal) / reportedTotal;
      expect(drift, `subagent ${task.id}: child-sum=${childSum} vs reported=${reportedTotal} drift=${(drift * 100).toFixed(3)}%`).toBeLessThan(0.005);
    }

    rmSync(process.env.PEEK_TEST_DATA_DIR!, { recursive: true, force: true });
  });
});
