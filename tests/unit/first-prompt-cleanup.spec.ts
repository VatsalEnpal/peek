/**
 * Unit (L12): `session.firstPrompt` is cleaned of `<command-*>…</command-*>`
 * XML. Slash commands like `/peek_start` surface as raw XML in the user
 * stream; the session card title should show the USER'S first real prompt,
 * not the slash-command payload.
 *
 * Rules:
 *   1. If the first user_prompt is a command-only message, skip it and use
 *      the next non-command prompt as firstPrompt.
 *   2. If every prompt is a command, use the command name as firstPrompt
 *      (prefixed with `/`) so the card title still says something useful.
 *   3. If no command XML is present, behavior is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { assembleSession, type AssembleContext } from '@server/pipeline/model';

const baseCtx: AssembleContext = { sourceFile: '/tmp/session.jsonl' };

function userEvt(uuid: string, parent: string | null, text: string) {
  return {
    type: 'user',
    uuid,
    parentUuid: parent,
    sessionId: 'sess-L12',
    cwd: '/tmp',
    gitBranch: 'main',
    version: '2.1.114',
    entrypoint: 'cli',
    timestamp: '2026-04-19T11:00:00.000Z',
    message: { role: 'user', content: text },
  };
}

describe('firstPrompt cleanup for slash-command sessions (L12)', () => {
  it('skips a command-only first prompt, uses the next real prompt', () => {
    const events = [
      userEvt(
        'u1',
        null,
        '<command-message>peek_start</command-message> <command-name>/peek_start</command-name>'
      ),
      userEvt('u2', 'u1', 'Research G-Brain and how that applies'),
    ];
    const session = assembleSession(events, baseCtx);
    expect(session.firstPrompt).toBe('Research G-Brain and how that applies');
  });

  it('when every prompt is a command, falls back to the command name', () => {
    const events = [
      userEvt(
        'u1',
        null,
        '<command-message>peek_start</command-message> <command-name>/peek_start</command-name>'
      ),
      userEvt(
        'u2',
        'u1',
        '<command-message>peek_end</command-message> <command-name>/peek_end</command-name>'
      ),
    ];
    const session = assembleSession(events, baseCtx);
    // Should be the last command name (user's most-recent intent). Either
    // "/peek_end" or "peek_end" is acceptable — just must NOT be the raw XML.
    expect(session.firstPrompt).toBeDefined();
    expect(session.firstPrompt).not.toMatch(/<command-/);
    expect(session.firstPrompt).toMatch(/peek_end|peek_start/);
  });

  it('leaves non-command first prompt unchanged', () => {
    const events = [userEvt('u1', null, 'Hello, just a regular prompt')];
    const session = assembleSession(events, baseCtx);
    expect(session.firstPrompt).toBe('Hello, just a regular prompt');
  });

  it('handles command-name-only (no command-message) as command', () => {
    const events = [
      userEvt('u1', null, '<command-name>/loop</command-name>'),
      userEvt('u2', 'u1', 'Actual prompt here'),
    ];
    const session = assembleSession(events, baseCtx);
    expect(session.firstPrompt).toBe('Actual prompt here');
  });
});
