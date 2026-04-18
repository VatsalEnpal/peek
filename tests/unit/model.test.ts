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
  blocks: Array<{ type: string; name?: string; id?: string; text?: string }>,
  usage: Record<string, number> | null = null,
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

describe('assembleSession', () => {
  it('returns a Session with empty collections for an empty event array', () => {
    const session = assembleSession([], baseCtx);
    expect(session.turns).toEqual([]);
    expect(session.spans).toEqual([]);
    expect(session.ledger).toEqual([]);
    expect(session.id).toBeDefined();
  });

  it('creates one Turn for a single user prompt event', () => {
    const events = [userEvt('u1', null, 'hello world')];
    const session = assembleSession(events, baseCtx);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].id).toBeTypeOf('string');
    expect(session.turns[0].index).toBe(0);
    expect(session.cwd).toBe('/home/u/proj');
    expect(session.gitBranch).toBe('main');
    expect(session.ccVersion).toBe('2.1.114');
    expect(session.entrypoint).toBe('cli');
  });

  it('creates spans for each content block of assistant events belonging to the latest user turn', () => {
    const events = [
      userEvt('u1', null, 'please do stuff'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'Sure.' }], {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistantEvt(
        'a2',
        'a1',
        [{ type: 'tool_use', name: 'Bash', id: 'tool_1' }],
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        { messageId: 'msg_X' }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    expect(session.turns).toHaveLength(1);
    // 1 user_prompt span + 2 content blocks = 3 spans total
    expect(session.spans.length).toBeGreaterThanOrEqual(3);
    const toolSpan = session.spans.find((s) => s.type === 'tool_call');
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.name).toBe('Bash');
    const apiSpan = session.spans.find((s) => s.type === 'api_call');
    expect(apiSpan).toBeDefined();
  });

  it('converts snake_case message.usage into camelCase Turn.usage', () => {
    const events = [
      userEvt('u1', null, 'go'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'ok' }], {
        input_tokens: 5,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      }),
    ];
    const session = assembleSession(events, baseCtx);
    const u = session.turns[0].usage!;
    expect(u).toBeDefined();
    expect(u.inputTokens).toBe(5);
    expect(u.outputTokens).toBe(100);
    expect(u.cacheCreationTokens).toBe(200);
    expect(u.cacheReadTokens).toBe(300);
    // snake_case must NOT leak through
    expect((u as any).input_tokens).toBeUndefined();
    expect((u as any).cache_creation_input_tokens).toBeUndefined();
    expect((u as any).cache_read_input_tokens).toBeUndefined();
  });

  it('emits ledger entries with camelCase turnId and numeric tokens', () => {
    const tokenOf = (s: string) => s.length;
    const events = [
      userEvt('u1', null, 'hello'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'hi there' }], {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const session = assembleSession(events, { ...baseCtx, tokenOf });
    expect(session.ledger.length).toBeGreaterThan(0);
    for (const entry of session.ledger) {
      expect(entry.turnId).toBeTypeOf('string');
      expect(entry.tokens).toBeTypeOf('number');
      expect((entry as any).turn_id).toBeUndefined();
    }
    // tokenOf callback was invoked: at least one entry has tokens > 0.
    expect(session.ledger.some((e) => e.tokens > 0)).toBe(true);
  });

  it('builds parentSpanId / childSpanIds from parentUuid chain', () => {
    const events = [
      userEvt('u1', null, 'go'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'parent block' }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistantEvt(
        'a2',
        'a1',
        [{ type: 'tool_use', name: 'Bash', id: 'tool_1' }],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        { messageId: 'msg_Y' }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const a1Span = session.spans.find((s) => s.id === 'a1');
    const a2Span = session.spans.find((s) => s.id === 'a2');
    expect(a1Span).toBeDefined();
    expect(a2Span).toBeDefined();
    expect(a2Span!.parentSpanId).toBe('a1');
    expect(a1Span!.childSpanIds).toContain('a2');
  });

  it('maps tool_use with name "Task" (or "TaskCreate") to SpanType "subagent"', () => {
    const events = [
      userEvt('u1', null, 'spawn'),
      assistantEvt('a1', 'u1', [{ type: 'tool_use', name: 'TaskCreate', id: 'tool_1' }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      assistantEvt(
        'a2',
        'u1',
        [{ type: 'tool_use', name: 'Task', id: 'tool_2' }],
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        { messageId: 'msg_Z' }
      ),
    ];
    const session = assembleSession(events, baseCtx);
    const subagentSpans = session.spans.filter((s) => s.type === 'subagent');
    expect(subagentSpans.length).toBe(2);
  });

  it('maps unrecognized event types to SpanType "unknown"', () => {
    const events = [
      userEvt('u1', null, 'go'),
      {
        type: 'some-weird-thing',
        uuid: 'w1',
        parentUuid: 'u1',
        timestamp: '2026-04-18T11:16:20.000Z',
      },
    ];
    const session = assembleSession(events, baseCtx);
    const w = session.spans.find((s) => s.id === 'w1');
    expect(w).toBeDefined();
    expect(w!.type).toBe('unknown');
  });

  it('sums ledger tokens per span into tokensConsumed', () => {
    const tokenOf = (_s: string) => 7;
    const events = [
      userEvt('u1', null, 'go'),
      assistantEvt('a1', 'u1', [{ type: 'text', text: 'hello' }], {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ];
    const session = assembleSession(events, { ...baseCtx, tokenOf });
    const a1 = session.spans.find((s) => s.id === 'a1')!;
    const ledgerTotal = session.ledger
      .filter((e) => e.introducedBySpanId === 'a1')
      .reduce((acc, e) => acc + e.tokens, 0);
    expect(a1.tokensConsumed).toBe(ledgerTotal);
    expect(a1.tokensConsumed).toBeGreaterThan(0);
  });

  it('deduplicates usage across assistant events sharing the same message.id', () => {
    // Real CC splits one assistant message into multiple events, all with the same
    // message.id and usage. Turn.usage must count that usage ONCE, not N times.
    const usage = {
      input_tokens: 10,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const events = [
      userEvt('u1', null, 'go'),
      assistantEvt('a1', 'u1', [{ type: 'thinking' }], usage, { messageId: 'msg_SAME' }),
      assistantEvt('a2', 'a1', [{ type: 'text', text: 'hi' }], usage, { messageId: 'msg_SAME' }),
      assistantEvt('a3', 'a2', [{ type: 'tool_use', name: 'Bash', id: 't1' }], usage, {
        messageId: 'msg_SAME',
      }),
    ];
    const session = assembleSession(events, baseCtx);
    const u = session.turns[0].usage!;
    expect(u.inputTokens).toBe(10); // not 30
    expect(u.outputTokens).toBe(50); // not 150
  });
});
