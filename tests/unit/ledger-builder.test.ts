/**
 * L1.3 ledger-builder tests.
 *
 * Per the builder plan §LedgerEntry (lines 143-150): every content block that
 * enters Claude's context must produce one `LedgerEntry` with
 *   - `tokens` from the offline tokenizer (> 0 for non-empty input),
 *   - `sourceOffset` with a 1-based `line` plus byte/char offsets within that
 *     line, and
 *   - `sourceLineHash` — a 64-char hex SHA-256 of the raw JSONL line.
 *
 * These tests exercise the integration at the `importPath` level so we also
 * validate the `ctx.redactOf` → `LedgerEntry.sourceOffset.line` wiring that
 * import.ts is responsible for plumbing.
 */

import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importPath } from '../../server/pipeline/import';
import type { Session } from '../../server/pipeline/model';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'peek-ledger-'));
}

function writeJsonl(dir: string, name: string, events: unknown[]): string {
  const file = join(dir, name);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('L1.3 ledger builder — sourceOffset + sourceLineHash', () => {
  test('user-prompt event → one ledger entry with tokens > 0, 64-hex hash, line >= 1', async () => {
    const tmp = freshTmp();
    const dataDir = freshTmp();
    try {
      const file = writeJsonl(tmp, 'one.jsonl', [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'led-1',
          cwd: '/tmp/led',
          timestamp: '2026-04-19T00:00:00.000Z',
          message: { role: 'user', content: 'what do you think about the redaction flow?' },
        },
      ]);

      const session = (await importPath(file, {
        preview: true,
        returnAssembled: true,
      })) as Session;

      const promptEntries = session.ledger.filter((e) => e.source === 'user_prompt');
      expect(promptEntries.length).toBe(1);
      const entry = promptEntries[0]!;

      expect(entry.tokens).toBeGreaterThan(0);
      expect(entry.sourceLineHash, 'top-level sourceLineHash must be set').toBeDefined();
      expect(entry.sourceLineHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sourceOffset, 'sourceOffset must be set').toBeDefined();
      expect(entry.sourceOffset!.line).toBeDefined();
      expect(entry.sourceOffset!.line).toBeGreaterThanOrEqual(1);
      expect(entry.sourceOffset!.sourceLineHash).toBe(entry.sourceLineHash);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('tool_result block → introducedBySpanId points at the matching tool_call span', async () => {
    const tmp = freshTmp();
    try {
      const file = writeJsonl(tmp, 'tool.jsonl', [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'led-2',
          timestamp: '2026-04-19T00:00:00.000Z',
          message: { role: 'user', content: 'run ls' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'led-2',
          timestamp: '2026-04-19T00:00:01.000Z',
          message: {
            id: 'msg-1',
            content: [
              { type: 'tool_use', id: 'toolu_LS1', name: 'Bash', input: { command: 'ls' } },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
        {
          type: 'user',
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId: 'led-2',
          timestamp: '2026-04-19T00:00:02.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_LS1',
                content: [{ type: 'text', text: 'foo.txt\nbar.txt\n' }],
              },
            ],
          },
        },
      ]);

      const session = (await importPath(file, {
        preview: true,
        returnAssembled: true,
      })) as Session;

      const toolSpan = session.spans.find(
        (s) => s.type === 'tool_call' && (s.metadata as any)?.toolUseId === 'toolu_LS1'
      );
      expect(toolSpan, 'tool_call span must exist').toBeDefined();

      const resultEntries = session.ledger.filter(
        (e) => e.source === 'tool_result' && e.introducedBySpanId === toolSpan!.id
      );
      expect(
        resultEntries.length,
        `tool_result must produce a ledger entry pointing at ${toolSpan!.id}`
      ).toBeGreaterThanOrEqual(1);

      const entry = resultEntries[0]!;
      expect(entry.tokens).toBeGreaterThan(0);
      expect(entry.sourceLineHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sourceOffset!.line).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('attachment with hook stdout → ledger entry emitted', async () => {
    const tmp = freshTmp();
    try {
      const file = writeJsonl(tmp, 'hook.jsonl', [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'led-3',
          timestamp: '2026-04-19T00:00:00.000Z',
          message: { role: 'user', content: 'seed' },
        },
        {
          type: 'attachment',
          uuid: 'at1',
          parentUuid: 'u1',
          sessionId: 'led-3',
          timestamp: '2026-04-19T00:00:01.000Z',
          attachment: {
            type: 'hook_success',
            hookName: 'post-tool-use',
            hookEvent: 'PostToolUse',
            content: 'hook wrote something useful',
            stdout: 'ok from hook\n',
            stderr: '',
            exitCode: 0,
            command: 'echo hi',
            durationMs: 12,
          },
        },
      ]);

      const session = (await importPath(file, {
        preview: true,
        returnAssembled: true,
      })) as Session;

      const attachmentEntries = session.ledger.filter((e) => e.source === 'attachment');
      expect(attachmentEntries.length).toBeGreaterThanOrEqual(1);

      const entry = attachmentEntries[0]!;
      expect(entry.tokens).toBeGreaterThan(0);
      expect(entry.sourceLineHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sourceOffset!.line).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('determinism: same input → identical ledger hashes', async () => {
    const tmp = freshTmp();
    try {
      const events = [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'led-4',
          timestamp: '2026-04-19T00:00:00.000Z',
          message: { role: 'user', content: 'stable content' },
        },
      ];
      const fileA = writeJsonl(tmp, 'a.jsonl', events);
      const fileB = writeJsonl(tmp, 'b.jsonl', events);

      const sessA = (await importPath(fileA, {
        preview: true,
        returnAssembled: true,
      })) as Session;
      const sessB = (await importPath(fileB, {
        preview: true,
        returnAssembled: true,
      })) as Session;

      const hashesA = sessA.ledger.map((e) => e.sourceLineHash);
      const hashesB = sessB.ledger.map((e) => e.sourceLineHash);

      expect(hashesA).toEqual(hashesB);
      // Each hash should be defined and 64-hex.
      for (const h of hashesA) {
        expect(h).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
