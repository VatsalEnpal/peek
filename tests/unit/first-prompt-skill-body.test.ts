/**
 * L5.3 — first-prompt cleanup extended.
 *
 * When Claude Code expands a slash command, the user stream contains
 * THREE messages: (1) `<command-message>…</command-message>` XML,
 * (2) the SKILL body markdown starting `# /peek_start — Open a Peek…`,
 * (3) the real user prompt if any.
 *
 * `session.firstPrompt` must skip both (1) and (2), locking on (3).
 */

import { describe, expect, test } from 'vitest';

import { assembleSession } from '../../server/pipeline/model';

function user(text: string, ts: string): any {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: ts,
    uuid: `u-${ts}`,
    sessionId: 'sess-1',
  };
}

describe('firstPrompt — skill body skipping (L5.3)', () => {
  test('locks on the first non-command, non-skill-body user prompt', () => {
    const events: any[] = [
      user(
        '<command-message>peek_start</command-message><command-name>/peek_start</command-name><command-args>my-test</command-args>',
        '2026-04-19T10:00:00Z'
      ),
      user(
        '# /peek_start — Open a Peek bookmark range\n\nThis skill opens a recording.',
        '2026-04-19T10:00:01Z'
      ),
      user('actually run the security scan', '2026-04-19T10:00:02Z'),
    ];

    const session = assembleSession(events, {});

    expect(session.firstPrompt).toBe('actually run the security scan');
  });

  test('skill body alone leaves firstPrompt at the command-name fallback', () => {
    const events: any[] = [
      user(
        '<command-message>peek_start</command-message><command-name>/peek_start</command-name>',
        '2026-04-19T10:00:00Z'
      ),
      user('# /peek_start — Open a Peek bookmark range', '2026-04-19T10:00:01Z'),
    ];

    const session = assembleSession(events, {});
    // Fallback is the slash-command name, never the skill body markdown.
    expect(session.firstPrompt).toBe('/peek_start');
  });
});
