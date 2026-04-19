import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseJsonl } from '../../server/pipeline/parser';

const REAL_FIXTURE = './tests/fixtures/isolated-claude-projects/real-session.jsonl';

describe('parseJsonl', () => {
  // Fixture-dependent coverage: drop any real Claude Code session JSONL at the
  // path above and this test asserts the parser handles it without error.
  // Skipped when the public repo ships without a fixture file.
  test.skipIf(!existsSync(REAL_FIXTURE))('parses real-session.jsonl without error', () => {
    const content = readFileSync(REAL_FIXTURE, 'utf8');
    const { events } = parseJsonl(content);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.type === 'string')).toBe(true);
  });

  test('collects gaps for malformed lines when trackGaps=true', () => {
    const content = '{"type":"user"}\nnot json\n{"type":"assistant"}\n';
    const { events, gaps } = parseJsonl(content, { trackGaps: true });
    expect(events.length).toBe(2);
    expect(gaps.length).toBe(1);
    expect(gaps[0].lineNumber).toBe(2);
    expect(gaps[0].raw).toBe('not json');
    expect(typeof gaps[0].error).toBe('string');
  });

  test('silently skips malformed lines when trackGaps omitted', () => {
    const content = '{"type":"user"}\nnot json\n';
    const { events, gaps } = parseJsonl(content);
    expect(events.length).toBe(1);
    expect(gaps.length).toBe(0);
  });

  test('ignores trailing newline and empty lines without recording gaps', () => {
    const content = '{"type":"user"}\n\n{"type":"assistant"}\n';
    const { events, gaps } = parseJsonl(content, { trackGaps: true });
    expect(events.length).toBe(2);
    expect(gaps.length).toBe(0);
  });

  test('gap lineNumber is 1-indexed source line number', () => {
    const content = '{"type":"user"}\n{"type":"assistant"}\nbroken\n{"type":"user"}\n';
    const { events, gaps } = parseJsonl(content, { trackGaps: true });
    expect(events.length).toBe(3);
    expect(gaps.length).toBe(1);
    expect(gaps[0].lineNumber).toBe(3);
    expect(gaps[0].raw).toBe('broken');
  });

  test('returns empty arrays for empty input', () => {
    const { events, gaps } = parseJsonl('', { trackGaps: true });
    expect(events).toEqual([]);
    expect(gaps).toEqual([]);
  });
});
