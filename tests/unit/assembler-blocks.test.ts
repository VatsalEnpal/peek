/**
 * L1.1 — Block-level assembler dispatch tests.
 *
 * Validates that `assembleSession` walks `message.content[]` block-by-block
 * and produces the correct SpanType per §DATA-MAPPING (plan lines 126-140).
 */
import { describe, it, expect } from 'vitest';
import { assembleSession, type AssembleContext } from '@server/pipeline/model';

const baseCtx: AssembleContext = { sourceFile: '/tmp/session.jsonl' };

function userEvt(
  uuid: string,
  parent: string | null,
  text: string,
  extras: Record<string, unknown> = {}
) {
  return {
    type: 'user',
    uuid,
    parentUuid: parent,
    sessionId: 'sess-1',
    cwd: '/home/u/proj',
    gitBranch: 'main',
    version: '2.1.114',
    entrypoint: 'cli',
    timestamp: '2026-04-18T11:16:07.326Z',
    message: { role: 'user', content: text },
    ...extras,
  };
}

function assistantEvt(
  uuid: string,
  parent: string | null,
  blocks: any[],
  usage: Record<string, unknown> | null = null,
  extras: Record<string, unknown> = {}
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: parent,
    sessionId: 'sess-1',
    cwd: '/home/u/proj',
    gitBranch: 'main',
    version: '2.1.114',
    entrypoint: 'cli',
    timestamp: '2026-04-18T11:16:10.000Z',
    message: {
      role: 'assistant',
      id: (extras.messageId as string) ?? `msg_${uuid}`,
      content: blocks,
      usage: usage ?? undefined,
    },
    ...extras,
  };
}

describe('assembler block dispatch (L1.1)', () => {
  it('maps text block → api_call span with text body as output', () => {
    const events = [
      userEvt('u1', null, 'prompt'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'Hello world' }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const session = assembleSession(events, baseCtx);
    const apiSpan = session.spans.find((s) => s.type === 'api_call' && s.id !== 'u1');
    expect(apiSpan, 'expected an api_call span from assistant text block').toBeDefined();
    // text block body should appear somewhere in outputs
    const outStr =
      typeof apiSpan!.outputs === 'string'
        ? apiSpan!.outputs
        : JSON.stringify(apiSpan!.outputs ?? '');
    expect(outStr).toContain('Hello world');
  });

  it('maps tool_use(Bash) → tool_call span with name "Bash" and inputs populated', () => {
    const events = [
      userEvt('u1', null, 'do'),
      assistantEvt(
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            name: 'Bash',
            id: 'toolu_bash1',
            input: { command: 'ls -la', description: 'list' },
          },
        ],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const tool = session.spans.find((s) => s.type === 'tool_call' && s.name === 'Bash');
    expect(tool).toBeDefined();
    expect(tool!.inputs).toBeDefined();
    const inputStr = typeof tool!.inputs === 'string' ? tool!.inputs : JSON.stringify(tool!.inputs);
    expect(inputStr).toContain('ls -la');
  });

  it('maps tool_use(Agent) → subagent span with name "Agent: <subagent_type>"', () => {
    const events = [
      userEvt('u1', null, 'delegate'),
      assistantEvt(
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            name: 'Agent',
            id: 'toolu_agent1',
            input: { description: 'do thing', subagent_type: 'ui-worker', prompt: 'build ui' },
          },
        ],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const sub = session.spans.find((s) => s.type === 'subagent');
    expect(sub, 'expected subagent span for Agent tool_use').toBeDefined();
    expect(sub!.name).toBe('Agent: ui-worker');
    // childSpanIds should be present (may be empty array — joiner fills L1.2)
    expect(Array.isArray(sub!.childSpanIds)).toBe(true);
  });

  it('maps tool_use(Skill) → skill_activation span with name from input.skill', () => {
    const events = [
      userEvt('u1', null, 'use skill'),
      assistantEvt(
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            name: 'Skill',
            id: 'toolu_sk1',
            input: { skill: 'plugin:superpowers:tdd' },
          },
        ],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const sk = session.spans.find((s) => s.type === 'skill_activation');
    expect(sk, 'expected skill_activation span for Skill tool_use').toBeDefined();
    expect(sk!.name).toBe('plugin:superpowers:tdd');
  });

  it('maps mcp__ tool_use → mcp_call span with full tool name', () => {
    const events = [
      userEvt('u1', null, 'mcp'),
      assistantEvt(
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            name: 'mcp__supabase__execute_sql',
            id: 'toolu_mcp1',
            input: { sql: 'select 1' },
          },
        ],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const mcp = session.spans.find((s) => s.type === 'mcp_call');
    expect(mcp).toBeDefined();
    expect(mcp!.name).toBe('mcp__supabase__execute_sql');
  });

  it('maps Read tool on a */memory/* path → memory_read span', () => {
    const events = [
      userEvt('u1', null, 'mem'),
      assistantEvt(
        'a1',
        'u1',
        [
          {
            type: 'tool_use',
            name: 'Read',
            id: 'toolu_mem1',
            input: { file_path: '/home/u/proj/ai-agents/memory/agent-notes.md' },
          },
        ],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const mem = session.spans.find((s) => s.type === 'memory_read');
    expect(mem).toBeDefined();
    expect(mem!.name).toBe('agent-notes.md');
  });

  it('maps attachment(hook_success) → hook_fire span with hookName:hookEvent name', () => {
    const events = [
      userEvt('u1', null, 'p'),
      {
        type: 'attachment',
        uuid: 'att1',
        parentUuid: 'u1',
        timestamp: '2026-04-18T11:16:11.000Z',
        attachment: {
          type: 'hook_success',
          hookName: 'prettier-check',
          hookEvent: 'PostToolUse',
          toolUseID: 'toolu_x',
          content: 'ok',
          stdout: 'done',
          stderr: '',
          exitCode: 0,
          command: 'npx prettier --check',
          durationMs: 42,
        },
      },
    ];
    const session = assembleSession(events, baseCtx);
    const hook = session.spans.find((s) => s.type === 'hook_fire');
    expect(hook, 'expected hook_fire span for hook_success attachment').toBeDefined();
    expect(hook!.name).toBe('prettier-check:PostToolUse');
    const outStr = JSON.stringify(hook!.outputs ?? {});
    expect(outStr).toContain('done');
  });

  it('maps system(stop_hook_summary) → hook_fire span', () => {
    const events = [
      userEvt('u1', null, 'p'),
      {
        type: 'system',
        uuid: 'sys1',
        parentUuid: 'u1',
        timestamp: '2026-04-18T11:16:12.000Z',
        subtype: 'stop_hook_summary',
        hookCount: 1,
        hookInfos: [{ command: 'h', durationMs: 10 }],
      },
    ];
    const session = assembleSession(events, baseCtx);
    const hook = session.spans.find((s) => s.id === 'sys1');
    expect(hook).toBeDefined();
    expect(hook!.type).toBe('hook_fire');
    expect(hook!.name).toBe('stop_hook_summary');
  });

  it('maps thinking block with < 500 tokens → no rendered thinking_block span (suppressed)', () => {
    // tokenOf simulates real tokenizer → short thinking = few tokens
    const tokenOf = (s: string) => Math.ceil(s.length / 4);
    const events = [
      userEvt('u1', null, 'p'),
      assistantEvt('a1', 'u1', [{ type: 'thinking', thinking: 'short thought' }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const session = assembleSession(events, { ...baseCtx, tokenOf });
    const thinkingSpans = session.spans.filter((s) => s.type === 'thinking_block');
    expect(thinkingSpans.length).toBe(0);
  });

  it('maps thinking block with > 500 tokens → renders as thinking_block span', () => {
    const longThought = 'x'.repeat(4000); // tokenOf below → 1000 tokens
    const tokenOf = (s: string) => Math.ceil(s.length / 4);
    const events = [
      userEvt('u1', null, 'p'),
      assistantEvt('a1', 'u1', [{ type: 'thinking', thinking: longThought }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const session = assembleSession(events, { ...baseCtx, tokenOf });
    const think = session.spans.find((s) => s.type === 'thinking_block');
    expect(think, 'expected thinking_block span when tokens > 500').toBeDefined();
    expect(think!.name).toBe('thinking');
  });

  it('sums message.usage.iterations[] into per-turn usage totals', () => {
    const events = [
      userEvt('u1', null, 'p'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'ok' }], {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        iterations: [
          {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
          },
          {
            input_tokens: 3,
            output_tokens: 4,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
          },
        ],
      }),
    ];
    const session = assembleSession(events, baseCtx);
    const u = session.turns[0].usage!;
    // Plan says: SUM over message.usage.iterations[] when present — so totals come from iteration sums.
    expect(u.inputTokens).toBe(13);
    expect(u.outputTokens).toBe(24);
    expect(u.cacheCreationTokens).toBe(6);
    expect(u.cacheReadTokens).toBe(9);
    expect(u.iterationCount).toBe(2);
  });

  it('links tool_use_id → user tool_result to populate outputs on tool_call span', () => {
    const events = [
      userEvt('u1', null, 'go'),
      assistantEvt(
        'a1',
        'u1',
        [{ type: 'tool_use', name: 'Bash', id: 'toolu_B1', input: { command: 'echo hi' } }],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      ),
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: '2026-04-18T11:16:11.000Z',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_B1', content: 'hi\n' }],
        },
      },
    ];
    const session = assembleSession(events, baseCtx);
    const tool = session.spans.find((s) => s.type === 'tool_call' && s.name === 'Bash');
    expect(tool).toBeDefined();
    const outStr =
      typeof tool!.outputs === 'string' ? tool!.outputs : JSON.stringify(tool!.outputs ?? '');
    expect(outStr).toContain('hi');
  });

  it('falls through to unknown SpanType and preserves raw in metadata.rawEvent', () => {
    const events = [
      userEvt('u1', null, 'p'),
      {
        type: 'weird-event-9',
        uuid: 'w1',
        parentUuid: 'u1',
        timestamp: '2026-04-18T11:16:20.000Z',
        payload: { x: 1 },
      },
    ];
    const session = assembleSession(events, baseCtx);
    const w = session.spans.find((s) => s.id === 'w1');
    expect(w).toBeDefined();
    expect(w!.type).toBe('unknown');
    expect(w!.metadata?.rawEvent).toBeDefined();
  });
});
