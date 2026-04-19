/**
 * Unit tests for the L1.2 subagent joiner.
 *
 * The v0.2 joiner extracts `agentId` from a `queued_command` attachment's
 * `<task-id>` tag (NOT from any tool_result footer), matches the attachment to
 * the originating `Agent` `tool_use` via `<tool-use-id>`, loads the child
 * transcript at
 *   <claudeProjectsDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 * (and its sibling `.meta.json`), runs the assembler on those child events,
 * and splices the resulting spans into the parent Session while populating
 * `parentSpan.childSpanIds`.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAgentIdFromQueuedCommand,
  findQueuedCommandForToolUse,
  joinSubagentsIntoSession,
} from '../../server/pipeline/subagent-joiner';
import { assembleSession, type Session, type ActionSpan } from '../../server/pipeline/model';

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-subagent-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length) {
    const d = createdDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Regex extraction
// ---------------------------------------------------------------------------

describe('extractAgentIdFromQueuedCommand', () => {
  test('extracts hex agentId from a realistic queued_command prompt', () => {
    const prompt = [
      '<task-notification>',
      '<task-id>a7f26c525a2784757</task-id>',
      '<tool-use-id>toolu_013QxyYMn1DE7UbRG6CwhNzr</tool-use-id>',
      '<output-file>/private/tmp/claude-502/foo/bar/tasks/a7f26c525a2784757.output</output-file>',
      '<status>completed</status>',
      '</task-notification>',
    ].join('\n');

    expect(extractAgentIdFromQueuedCommand(prompt)).toBe('a7f26c525a2784757');
  });

  test('returns null when no <task-id> tag is present', () => {
    expect(extractAgentIdFromQueuedCommand('<foo>bar</foo>')).toBeNull();
  });

  test('ignores non-hex characters — the regex accepts only [a-f0-9]', () => {
    // Uppercase / non-hex should not match (spec pins `/<task-id>([a-f0-9]+)<\/task-id>/`).
    expect(extractAgentIdFromQueuedCommand('<task-id>XYZ</task-id>')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Tool-use-id matching
// ---------------------------------------------------------------------------

describe('findQueuedCommandForToolUse', () => {
  test('picks the queued_command whose <tool-use-id> matches the given id', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_AAA', name: 'Agent', input: { subagent_type: 'x' } },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification>\n<task-id>aaa111</task-id>\n<tool-use-id>toolu_AAA</tool-use-id>\n</task-notification>',
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_BBB', name: 'Agent', input: { subagent_type: 'y' } },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification>\n<task-id>bbb222</task-id>\n<tool-use-id>toolu_BBB</tool-use-id>\n</task-notification>',
        },
      },
    ];

    const first = findQueuedCommandForToolUse(events, 'toolu_AAA');
    expect(first).not.toBeNull();
    expect(first!.agentId).toBe('aaa111');

    const second = findQueuedCommandForToolUse(events, 'toolu_BBB');
    expect(second).not.toBeNull();
    expect(second!.agentId).toBe('bbb222');
  });

  test('returns null when no matching queued_command exists', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_ZZZ', name: 'Agent', input: {} }],
        },
      },
    ];
    expect(findQueuedCommandForToolUse(events, 'toolu_ZZZ')).toBeNull();
  });

  test('skips queued_commands whose task-id is not valid hex', () => {
    const events = [
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: '<task-id>XYZ</task-id><tool-use-id>toolu_QQQ</tool-use-id>',
        },
      },
    ];
    expect(findQueuedCommandForToolUse(events, 'toolu_QQQ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Missing child JSONL → empty childSpanIds, no throw
// ---------------------------------------------------------------------------

describe('joinSubagentsIntoSession — missing sidecar', () => {
  test('emits warning-safe result: subagent span retains empty childSpanIds when JSONL missing', () => {
    const claudeProjectsDir = freshDir();
    const parentSessionId = 'parent-abc';
    // Parent session directory exists but subagents/agent-<id>.jsonl does NOT.
    mkdirSync(join(claudeProjectsDir, parentSessionId, 'subagents'), { recursive: true });

    const subagentSpan: ActionSpan = {
      id: 'span-sub-1',
      type: 'subagent',
      name: 'Agent: research',
      childSpanIds: [],
      tokensConsumed: 0,
      metadata: { toolUseId: 'toolu_XYZ' },
    };
    const session: Session = {
      id: parentSessionId,
      turns: [],
      spans: [subagentSpan],
      ledger: [],
    };

    const events = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_XYZ',
              name: 'Agent',
              input: { subagent_type: 'research' },
            },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: '<task-id>deadbeef</task-id><tool-use-id>toolu_XYZ</tool-use-id>',
        },
      },
    ];

    const warnings: string[] = [];
    const result = joinSubagentsIntoSession({
      session,
      events,
      claudeProjectsDir,
      assemble: (childEvents) =>
        assembleSession(childEvents, { sourceFile: 'child.jsonl', tokenOf: () => 0 }),
      onWarn: (msg) => warnings.push(msg),
    });

    // No throw, child ids stay empty.
    expect(result.session.spans.find((s) => s.id === 'span-sub-1')!.childSpanIds).toEqual([]);
    expect(warnings.some((w) => /deadbeef/.test(w))).toBe(true);
    expect(result.joinedAgentIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: parent with Agent tool_use + queued_command + real child JSONL
// ---------------------------------------------------------------------------

describe('joinSubagentsIntoSession — end-to-end', () => {
  test('parent subagent span gets childSpanIds populated from the child JSONL', () => {
    const claudeProjectsDir = freshDir();
    const parentSessionId = 'parent-sid';
    const agentId = 'abc123def456';

    const childDir = join(claudeProjectsDir, parentSessionId, 'subagents');
    mkdirSync(childDir, { recursive: true });

    // Child JSONL: one user prompt + one assistant text block.
    const childJsonl =
      JSON.stringify({
        type: 'user',
        uuid: 'child-user-1',
        timestamp: '2026-04-19T00:00:00.000Z',
        sessionId: `sub-${agentId}`,
        message: { role: 'user', content: 'please summarize' },
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        uuid: 'child-asst-1',
        parentUuid: 'child-user-1',
        timestamp: '2026-04-19T00:00:01.000Z',
        message: {
          id: 'msg_child_1',
          content: [{ type: 'text', text: 'Summary: hello world.' }],
          usage: { input_tokens: 5, output_tokens: 4 },
        },
      }) +
      '\n';

    writeFileSync(join(childDir, `agent-${agentId}.jsonl`), childJsonl);
    writeFileSync(
      join(childDir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType: 'researcher', description: 'do a thing' })
    );

    // Parent session with one subagent span.
    const subagentSpan: ActionSpan = {
      id: 'parent-span-1',
      type: 'subagent',
      name: 'Agent: researcher',
      childSpanIds: [],
      tokensConsumed: 0,
      metadata: { toolUseId: 'toolu_PARENT_1' },
    };
    const session: Session = {
      id: parentSessionId,
      turns: [],
      spans: [subagentSpan],
      ledger: [],
    };

    const parentEvents = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_PARENT_1',
              name: 'Agent',
              input: { subagent_type: 'researcher', description: 'do a thing' },
            },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: `<task-id>${agentId}</task-id><tool-use-id>toolu_PARENT_1</tool-use-id>`,
        },
      },
    ];

    const result = joinSubagentsIntoSession({
      session,
      events: parentEvents,
      claudeProjectsDir,
      assemble: (childEvents) =>
        assembleSession(childEvents, {
          sourceFile: join(childDir, `agent-${agentId}.jsonl`),
          tokenOf: (s) => s.length,
        }),
    });

    const parentSub = result.session.spans.find((s) => s.id === 'parent-span-1')!;
    expect(parentSub.childSpanIds.length).toBeGreaterThan(0);

    // Every childSpanId must resolve to an actual span inserted into the session.
    const spanById = new Map(result.session.spans.map((s) => [s.id, s]));
    for (const childId of parentSub.childSpanIds) {
      expect(spanById.has(childId)).toBe(true);
    }

    // metadata from .meta.json should be surfaced on the parent span.
    expect(parentSub.metadata).toMatchObject({
      agentType: 'researcher',
      agentId,
    });

    // joinedAgentIds should reflect what we stitched.
    expect(result.joinedAgentIds).toContain(agentId);
  });

  test('depth=1 only — grandchild Agent tool_use inside child JSONL does NOT recurse', () => {
    const claudeProjectsDir = freshDir();
    const parentSessionId = 'parent-sid-2';
    const agentId = 'cafebabe';

    const childDir = join(claudeProjectsDir, parentSessionId, 'subagents');
    mkdirSync(childDir, { recursive: true });

    // Child JSONL contains its OWN Agent tool_use — joiner must NOT recurse.
    const childJsonl =
      JSON.stringify({
        type: 'assistant',
        uuid: 'gc-1',
        message: {
          id: 'msg_gc_1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_GRANDCHILD',
              name: 'Agent',
              input: { subagent_type: 'nested' },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) + '\n';
    writeFileSync(join(childDir, `agent-${agentId}.jsonl`), childJsonl);

    const subagentSpan: ActionSpan = {
      id: 'parent-span-2',
      type: 'subagent',
      name: 'Agent: outer',
      childSpanIds: [],
      tokensConsumed: 0,
      metadata: { toolUseId: 'toolu_OUTER' },
    };
    const session: Session = {
      id: parentSessionId,
      turns: [],
      spans: [subagentSpan],
      ledger: [],
    };

    const parentEvents = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_OUTER',
              name: 'Agent',
              input: { subagent_type: 'outer' },
            },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: `<task-id>${agentId}</task-id><tool-use-id>toolu_OUTER</tool-use-id>`,
        },
      },
    ];

    const result = joinSubagentsIntoSession({
      session,
      events: parentEvents,
      claudeProjectsDir,
      assemble: (childEvents) =>
        assembleSession(childEvents, {
          sourceFile: 'child.jsonl',
          tokenOf: () => 0,
        }),
    });

    // The grandchild Agent span exists but its childSpanIds must be empty.
    const childSpans = result.session.spans.filter((s) => s.type === 'subagent');
    // Two subagent spans now: the top-level outer, and the grandchild emitted as a regular span.
    const grandchild = childSpans.find((s) => s.metadata?.['toolUseId'] === 'toolu_GRANDCHILD');
    expect(grandchild).toBeDefined();
    expect(grandchild!.childSpanIds).toEqual([]);
  });
});
