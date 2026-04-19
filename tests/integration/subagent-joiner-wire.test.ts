/**
 * L1.3 integration — verify that `server/pipeline/import.ts` invokes the
 * L1.2 subagent joiner so Agent spans end up with populated `childSpanIds`.
 *
 * We synthesize a tiny claudeProjectsDir structure:
 *   <claudeProjectsDir>/<parentSessionId>.jsonl       (parent transcript)
 *   <claudeProjectsDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 *
 * The parent transcript contains an Agent `tool_use` + matching
 * `queued_command` attachment. The child transcript contains a user-prompt +
 * assistant-text pair. After `importPath` runs:
 *
 *   1. The returned Session's Agent span must have non-empty `childSpanIds`.
 *   2. The child spans must be queryable via `Store.listEvents(parentSessionId)`
 *      (they were spliced into the parent Session and persisted with their
 *      `parentSpanId` rewritten to the Agent span).
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importPath } from '../../server/pipeline/import';
import { Store } from '../../server/pipeline/store';
import type { Session } from '../../server/pipeline/model';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'peek-joinerwire-'));
}

describe('L1.3 wire — subagent joiner invoked from import.ts', () => {
  test('Agent span ends up with populated childSpanIds + child spans persist', async () => {
    const claudeProjectsDir = freshTmp();
    const dataDir = freshTmp();

    try {
      const parentSessionId = 'parent-wire-1';
      const agentId = 'a1b2c3d4e5f6';
      const toolUseId = 'toolu_WIRE_1';

      // 1. Child transcript: one user prompt + one assistant text.
      const childDir = join(claudeProjectsDir, parentSessionId, 'subagents');
      mkdirSync(childDir, { recursive: true });
      const childJsonl =
        JSON.stringify({
          type: 'user',
          uuid: 'child-u1',
          sessionId: `sub-${agentId}`,
          timestamp: '2026-04-19T00:00:10.000Z',
          message: { role: 'user', content: 'please summarize' },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          uuid: 'child-a1',
          parentUuid: 'child-u1',
          sessionId: `sub-${agentId}`,
          timestamp: '2026-04-19T00:00:11.000Z',
          message: {
            id: 'msg_child_wire',
            content: [{ type: 'text', text: 'Here is the summary.' }],
            usage: {
              input_tokens: 3,
              output_tokens: 4,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }) +
        '\n';
      writeFileSync(join(childDir, `agent-${agentId}.jsonl`), childJsonl);
      writeFileSync(
        join(childDir, `agent-${agentId}.meta.json`),
        JSON.stringify({ agentType: 'wire-researcher', description: 'wire test' })
      );

      // 2. Parent transcript: user prompt -> assistant with Agent tool_use ->
      //    attachment(queued_command) binding tool_use_id to agentId.
      const parentEvents = [
        {
          type: 'user',
          uuid: 'p-u1',
          sessionId: parentSessionId,
          cwd: '/tmp/wire',
          gitBranch: 'main',
          version: '2.1.114',
          entrypoint: 'cli',
          timestamp: '2026-04-19T00:00:00.000Z',
          message: { role: 'user', content: 'spawn a researcher' },
        },
        {
          type: 'assistant',
          uuid: 'p-a1',
          parentUuid: 'p-u1',
          sessionId: parentSessionId,
          timestamp: '2026-04-19T00:00:01.000Z',
          message: {
            id: 'msg_p_1',
            content: [
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'Agent',
                input: { subagent_type: 'wire-researcher', description: 'wire test' },
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
        {
          type: 'attachment',
          uuid: 'p-at1',
          parentUuid: 'p-a1',
          sessionId: parentSessionId,
          timestamp: '2026-04-19T00:00:02.000Z',
          attachment: {
            type: 'queued_command',
            prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n</task-notification>`,
          },
        },
      ];

      const parentFile = join(claudeProjectsDir, `${parentSessionId}.jsonl`);
      writeFileSync(parentFile, parentEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

      // 3. Run the full import — this must now invoke the joiner automatically.
      const session = (await importPath(parentFile, {
        dataDir,
        returnAssembled: true,
      })) as Session;

      // 4. Agent span must have non-empty childSpanIds.
      const agentSpan = session.spans.find(
        (s) => s.type === 'subagent' && (s.metadata as any)?.toolUseId === toolUseId
      );
      expect(agentSpan, 'parent Agent span not found').toBeDefined();
      expect(agentSpan!.childSpanIds.length).toBeGreaterThan(0);
      // joiner surfaces agentId on metadata once stitched.
      expect((agentSpan!.metadata as any)?.agentId).toBe(agentId);

      // 5. Child spans are persisted & queryable via the store.
      const store = new Store(dataDir);
      try {
        const events = store.listEvents(parentSessionId);
        const spanEvents = events.filter((e) => e.kind === 'span') as Array<{
          id: string;
          parentSpanId?: string;
          type: string;
        }>;

        // Every agentSpan.childSpanIds entry must be queryable from the store.
        const spanIds = new Set(spanEvents.map((s) => s.id));
        for (const cid of agentSpan!.childSpanIds) {
          expect(spanIds.has(cid), `child span ${cid} missing from store`).toBe(true);
        }

        // At least one persisted span points back at the Agent span.
        const childrenOfAgent = spanEvents.filter((s) => s.parentSpanId === agentSpan!.id);
        expect(childrenOfAgent.length).toBeGreaterThan(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(claudeProjectsDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
