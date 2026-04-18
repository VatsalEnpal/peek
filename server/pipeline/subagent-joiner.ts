/**
 * Subagent footer extractor + sidecar joiner.
 *
 * Parent sessions emit a footer of the form:
 *
 *   agentId: <hex>
 *   <usage>
 *     total_tokens: N
 *     tool_uses: N        (optional)
 *     duration_ms: N      (optional)
 *   </usage>
 *
 * Sidecar events for a subagent live in `<sessionDir>/<agentId>.jsonl`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SubagentFooter = {
  /** 6+ hex chars. */
  agentId: string;
  /** Parsed from `total_tokens: N` inside `<usage>…</usage>`. */
  totalTokens: number;
  /** Parsed from `tool_uses: N` if present. */
  toolUses?: number;
  /** Parsed from `duration_ms: N` if present. */
  durationMs?: number;
};

export type JoinResult = {
  agentId: string;
  footer: SubagentFooter;
  /** Absolute path to the sidecar file, or null when missing. */
  sidecarPath: string | null;
  /** Parsed sidecar events. `[]` when missing or fully truncated. */
  sidecarEvents: any[];
  sidecarStatus: 'ok' | 'missing' | 'truncated';
};

const FOOTER_RE = /agentId:\s*([a-f0-9]{6,})\s*\n<usage>([\s\S]*?)<\/usage>/;

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function parseIntField(block: string, key: string): number | undefined {
  const re = new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`);
  for (const line of block.split('\n')) {
    const m = line.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) {
        return n;
      }
    }
  }
  return undefined;
}

export function extractSubagentFooter(content: string): SubagentFooter | null {
  const text = normalize(content);
  const m = text.match(FOOTER_RE);
  if (!m) return null;

  const agentId = m[1];
  const block = m[2];

  const totalTokens = parseIntField(block, 'total_tokens');
  if (totalTokens === undefined || totalTokens <= 0) {
    return null;
  }

  const footer: SubagentFooter = { agentId, totalTokens };

  const toolUses = parseIntField(block, 'tool_uses');
  if (toolUses !== undefined) footer.toolUses = toolUses;

  const durationMs = parseIntField(block, 'duration_ms');
  if (durationMs !== undefined) footer.durationMs = durationMs;

  return footer;
}

type SidecarRead = {
  events: any[];
  status: 'ok' | 'truncated';
};

function parseSidecar(content: string): SidecarRead {
  const text = normalize(content);
  if (text.length === 0) {
    return { events: [], status: 'ok' };
  }

  const lines = text.split('\n');
  const events: any[] = [];

  // Identify the last non-empty line. If it fails to parse, mark truncated
  // and include only the successfully-parsed events up to that point.
  let lastNonEmptyIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) {
      lastNonEmptyIdx = i;
      break;
    }
  }

  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      if (i === lastNonEmptyIdx) {
        truncated = true;
      }
      // Silently skip other malformed lines.
    }
  }

  return { events, status: truncated ? 'truncated' : 'ok' };
}

export function joinSubagent(opts: {
  parentSession: { content: string };
  agentId: string;
  sessionDir: string;
}): JoinResult {
  const { parentSession, agentId, sessionDir } = opts;

  const footer = extractSubagentFooter(parentSession.content);
  if (!footer) {
    throw new Error(`joinSubagent: no footer found in parent session for agentId=${agentId}`);
  }

  const sidecarPath = join(sessionDir, `${agentId}.jsonl`);

  if (!existsSync(sidecarPath)) {
    return {
      agentId,
      footer,
      sidecarPath: null,
      sidecarEvents: [],
      sidecarStatus: 'missing',
    };
  }

  const raw = readFileSync(sidecarPath, 'utf8');
  const { events, status } = parseSidecar(raw);

  return {
    agentId,
    footer,
    sidecarPath,
    sidecarEvents: events,
    sidecarStatus: status,
  };
}
