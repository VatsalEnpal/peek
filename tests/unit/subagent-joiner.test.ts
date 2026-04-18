import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSubagentFooter, joinSubagent } from '../../server/pipeline/subagent-joiner';

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

describe('extractSubagentFooter', () => {
  test('returns null when no footer is present', () => {
    const content = '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi"}\n';
    expect(extractSubagentFooter(content)).toBeNull();
  });

  test('returns null when footer is malformed (non-numeric total_tokens)', () => {
    const content = 'agentId: abc123\n<usage>\n  total_tokens: not-a-number\n</usage>\n';
    expect(extractSubagentFooter(content)).toBeNull();
  });

  test('parses optional toolUses and durationMs when present', () => {
    const content =
      'prefix junk\nagentId: deadbeef\n<usage>\n  total_tokens: 4321\n  tool_uses: 7\n  duration_ms: 9000\n</usage>\nmore junk\n';
    const footer = extractSubagentFooter(content);
    expect(footer).not.toBeNull();
    expect(footer!.agentId).toBe('deadbeef');
    expect(footer!.totalTokens).toBe(4321);
    expect(footer!.toolUses).toBe(7);
    expect(footer!.durationMs).toBe(9000);
  });
});

describe('joinSubagent', () => {
  test('footer present + sidecar present → returns ok status with events', () => {
    const dir = freshDir();
    const agentId = 'a1b2c3';
    const parentContent =
      'something else\nagentId: a1b2c3\n<usage>\n  total_tokens: 1234\n</usage>\n';
    const sidecarContent =
      '{"type":"user","text":"inside sub"}\n{"type":"assistant","text":"reply"}\n';
    writeFileSync(join(dir, `${agentId}.jsonl`), sidecarContent);

    const res = joinSubagent({
      parentSession: { content: parentContent },
      agentId,
      sessionDir: dir,
    });

    expect(res.agentId).toBe(agentId);
    expect(res.footer.totalTokens).toBe(1234);
    expect(res.sidecarStatus).toBe('ok');
    expect(res.sidecarPath).toBe(join(dir, `${agentId}.jsonl`));
    expect(res.sidecarEvents.length).toBe(2);
    expect(res.sidecarEvents[0].type).toBe('user');
    expect(res.sidecarEvents[1].type).toBe('assistant');
  });

  test('footer present + sidecar missing → status missing with empty events', () => {
    const dir = freshDir();
    const agentId = 'abcdef';
    const parentContent = 'agentId: abcdef\n<usage>\n  total_tokens: 42\n</usage>\n';

    const res = joinSubagent({
      parentSession: { content: parentContent },
      agentId,
      sessionDir: dir,
    });

    expect(res.agentId).toBe(agentId);
    expect(res.footer.totalTokens).toBe(42);
    expect(res.sidecarStatus).toBe('missing');
    expect(res.sidecarPath).toBeNull();
    expect(res.sidecarEvents).toEqual([]);
  });

  test('footer present + sidecar truncated → status truncated with partial events', () => {
    const dir = freshDir();
    const agentId = 'bad1ce';
    const parentContent = 'agentId: bad1ce\n<usage>\n  total_tokens: 99\n</usage>\n';
    // Last non-empty line is malformed JSON (truncated).
    const sidecarContent =
      '{"type":"user","text":"ok"}\n{"type":"assistant","text":"also ok"}\n{"type":"assistant","tex';
    writeFileSync(join(dir, `${agentId}.jsonl`), sidecarContent);

    const res = joinSubagent({
      parentSession: { content: parentContent },
      agentId,
      sessionDir: dir,
    });

    expect(res.sidecarStatus).toBe('truncated');
    expect(res.sidecarEvents.length).toBe(2);
    expect(res.sidecarEvents[0].text).toBe('ok');
    expect(res.sidecarEvents[1].text).toBe('also ok');
  });

  test('footer with optional metadata and sidecar present', () => {
    const dir = freshDir();
    const agentId = 'feedface';
    const parentContent =
      'agentId: feedface\n<usage>\n  total_tokens: 500\n  tool_uses: 3\n  duration_ms: 1500\n</usage>\n';
    writeFileSync(join(dir, `${agentId}.jsonl`), '{"type":"user","text":"q"}\n');

    const res = joinSubagent({
      parentSession: { content: parentContent },
      agentId,
      sessionDir: dir,
    });

    expect(res.footer.toolUses).toBe(3);
    expect(res.footer.durationMs).toBe(1500);
    expect(res.footer.totalTokens).toBe(500);
    expect(res.sidecarStatus).toBe('ok');
    expect(res.sidecarEvents).toHaveLength(1);
  });
});
