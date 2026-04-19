/**
 * Checker finding #3: 178/178 `tool_call` spans had `tokens: undefined`.
 *
 * The pipeline must populate `tokensConsumed` on every emitted Span and it
 * must be a positive number for:
 *   - user_prompt (tokens of prompt text),
 *   - api_call    (tokens of assistant text body),
 *   - tool_call   (tokens of the matching tool_result content),
 *   - skill_activation / mcp_call / memory_read / hook_fire (per §DATA-MAPPING).
 *
 * This is the assembler-layer test — feed a synthetic event sequence
 * (Agent prompt → Bash tool_use → user tool_result with output "hello world")
 * and assert tokensConsumed is numeric > 0 on both the user_prompt span and
 * the Bash tool_call span. The assembler is handed a `tokenOf` closure that
 * counts tokens for every content string it sees — INCLUDING tool_result
 * payloads. Before this fix, `collectContentBlocks` in import.ts skipped
 * tool_result content, so the tokenMap lookup returned 0, so tool_call spans
 * got `tokensConsumed = 0`.
 */
import { describe, it, expect } from 'vitest';
import { assembleSession, type AssembleContext } from '@server/pipeline/model';

function tokenOf(content: string): number {
  // Cheap deterministic counter: 1 token per 3 chars (rounded up).
  if (content.length === 0) return 0;
  return Math.max(1, Math.ceil(content.length / 3));
}

const ctx: AssembleContext = { sourceFile: '/tmp/session.jsonl', tokenOf };

describe('assembler token accounting (checker finding 3)', () => {
  it('populates tokensConsumed on user_prompt, api_call, and tool_call spans', () => {
    const events = [
      {
        type: 'user',
        uuid: 'u-1',
        parentUuid: null,
        sessionId: 'sess-tokens',
        cwd: '/tmp/x',
        timestamp: '2026-04-19T10:00:00Z',
        message: { role: 'user', content: 'please run ls and report what you see' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'sess-tokens',
        timestamp: '2026-04-19T10:00:01Z',
        message: {
          role: 'assistant',
          id: 'msg-1',
          content: [
            { type: 'text', text: 'Running ls now.' },
            {
              type: 'tool_use',
              id: 'toolu_01abc',
              name: 'Bash',
              input: { command: 'ls', description: 'list dir' },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'user',
        uuid: 'u-2',
        parentUuid: 'a-1',
        sessionId: 'sess-tokens',
        timestamp: '2026-04-19T10:00:02Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01abc',
              content: 'hello world — this is the tool output with enough bytes to tokenize',
            },
          ],
        },
      },
    ];

    const session = assembleSession(events, ctx);

    const promptSpan = session.spans.find((s) => s.type === 'user_prompt');
    const apiSpan = session.spans.find((s) => s.type === 'api_call');
    const toolSpan = session.spans.find((s) => s.type === 'tool_call' && s.name === 'Bash');

    expect(promptSpan).toBeDefined();
    expect(apiSpan).toBeDefined();
    expect(toolSpan).toBeDefined();

    // Every span must have a numeric tokensConsumed.
    expect(typeof promptSpan!.tokensConsumed).toBe('number');
    expect(typeof apiSpan!.tokensConsumed).toBe('number');
    expect(typeof toolSpan!.tokensConsumed).toBe('number');

    // And it must be > 0 where we have content (the checker's real complaint).
    expect(promptSpan!.tokensConsumed).toBeGreaterThan(0);
    expect(apiSpan!.tokensConsumed).toBeGreaterThan(0);
    // tool_call pays the cost of the tool_result payload returned to Claude.
    expect(toolSpan!.tokensConsumed).toBeGreaterThan(0);
  });

  it('tool_call with no matching tool_result falls back to 0 (orphan)', () => {
    const events = [
      {
        type: 'user',
        uuid: 'u-1',
        parentUuid: null,
        sessionId: 'sess-tokens-orphan',
        timestamp: '2026-04-19T10:00:00Z',
        message: { role: 'user', content: 'do something' },
      },
      {
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'sess-tokens-orphan',
        timestamp: '2026-04-19T10:00:01Z',
        message: {
          role: 'assistant',
          id: 'msg-1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_orphan',
              name: 'Bash',
              input: { command: 'noop' },
            },
          ],
          usage: {
            input_tokens: 5,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ];

    const session = assembleSession(events, ctx);
    const toolSpan = session.spans.find((s) => s.type === 'tool_call');
    expect(toolSpan).toBeDefined();
    expect(typeof toolSpan!.tokensConsumed).toBe('number');
    // Still a number — 0 is acceptable because there was no tool_result.
    expect(toolSpan!.tokensConsumed).toBeGreaterThanOrEqual(0);
  });
});
