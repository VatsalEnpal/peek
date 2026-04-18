import { describe, test, expect } from 'vitest';
import { composeLabel, cleanPrompt, timeAgo } from '../../server/identity/session-label';
import type { Session } from '../../server/pipeline/model';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abcdef1234567890',
    slug: 'fluffy-teapot',
    gitBranch: 'main',
    firstPrompt: 'hello world this is my prompt',
    startTs: new Date(Date.now() - 60_000).toISOString(),
    turns: [],
    spans: [],
    ledger: [],
    ...overrides,
  };
}

describe('composeLabel (Task 14.1)', () => {
  const NOW = new Date('2026-04-19T00:00:00Z');

  test('returns slug · "first prompt" · branch · timeAgo', () => {
    const s = makeSession({
      startTs: '2026-04-18T23:58:00Z',
    });
    expect(composeLabel(s, NOW)).toBe(
      'fluffy-teapot · "hello world this is my prompt" · main · 2m ago'
    );
  });

  test('truncates first prompt at 40 chars with ellipsis', () => {
    const s = makeSession({
      firstPrompt: 'a'.repeat(50) + ' and more content beyond the truncation boundary',
    });
    const label = composeLabel(s, NOW);
    expect(label).toContain('"' + 'a'.repeat(40) + '…"');
  });

  test('strips command tags from prompt', () => {
    const s = makeSession({
      firstPrompt: '<command-name>/loop</command-name>real prompt text',
    });
    expect(composeLabel(s, NOW)).toContain('"real prompt text"');
  });

  test('falls back to id prefix when slug missing', () => {
    const s = makeSession({ slug: undefined });
    expect(composeLabel(s, NOW)).toMatch(/^abcdef12 · /);
  });

  test('falls back to "no-branch" when gitBranch missing', () => {
    const s = makeSession({ gitBranch: undefined });
    expect(composeLabel(s, NOW)).toContain(' · no-branch · ');
  });

  test('different branches produce distinct labels', () => {
    const a = composeLabel(makeSession({ gitBranch: 'main' }), NOW);
    const b = composeLabel(makeSession({ gitBranch: 'feature' }), NOW);
    expect(a).not.toEqual(b);
  });

  test('timeAgo handles s/m/h/d', () => {
    const base = new Date('2026-04-19T00:00:00Z');
    expect(timeAgo('2026-04-18T23:59:30Z', base)).toBe('30s ago');
    expect(timeAgo('2026-04-18T23:00:00Z', base)).toBe('1h ago');
    expect(timeAgo('2026-04-18T00:00:00Z', base)).toBe('1d ago');
  });

  test('cleanPrompt removes multiple command tags', () => {
    expect(cleanPrompt('<command-name>x</command-name> hi <command-args>y</command-args>')).toBe(
      'hi'
    );
  });
});
