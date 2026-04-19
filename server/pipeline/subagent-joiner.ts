/**
 * L1.2 subagent joiner — v0.2.
 *
 * Per §DATA-MAPPING (builder plan lines 100-112), Claude Code now emits a
 * `queued_command` attachment AFTER each `Agent` tool_use, whose `prompt`
 * field contains an XML-ish block:
 *
 *   <task-notification>
 *     <task-id>a7f26c525a2784757</task-id>
 *     <tool-use-id>toolu_013Qxy...</tool-use-id>
 *     <output-file>/private/tmp/.../tasks/<agentId>.output</output-file>
 *     ...
 *   </task-notification>
 *
 * The authoritative link between a parent `Agent` tool_use and its child
 * transcript is `<tool-use-id>` (which equals the parent `tool_use.id`). From
 * the matching queued_command we pull `agentId` via the regex
 *
 *   /<task-id>([a-f0-9]+)<\/task-id>/
 *
 * (exactly — uppercase / non-hex is intentionally rejected, per the plan's
 * "regex trap" warning). The child transcript lives at
 *
 *   <claudeProjectsDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 *
 * with a sibling `agent-<agentId>.meta.json` carrying `{agentType,
 * description}`.
 *
 * We DO NOT recurse (depth=1). If the child transcript itself contains Agent
 * tool_uses they are emitted as regular subagent spans with empty
 * `childSpanIds`.
 *
 * Isolation: all file reads are constrained to stay under `claudeProjectsDir`
 * — a resolved child path outside that root is refused.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { parseJsonl } from './parser';
import type { Session } from './model';

// ---------------------------------------------------------------------------
// 1. Regex helpers
// ---------------------------------------------------------------------------

/** Spec-pinned regex: `<task-id>([a-f0-9]+)</task-id>`. */
const TASK_ID_RE = /<task-id>([a-f0-9]+)<\/task-id>/;
const TOOL_USE_ID_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/;

/**
 * Extracts the hex `agentId` from a `queued_command` attachment's `prompt`.
 * Returns `null` when no `<task-id>` tag matches `[a-f0-9]+`.
 */
export function extractAgentIdFromQueuedCommand(prompt: string): string | null {
  const m = TASK_ID_RE.exec(prompt);
  return m ? m[1] : null;
}

function extractToolUseIdFromQueuedCommand(prompt: string): string | null {
  const m = TOOL_USE_ID_RE.exec(prompt);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// 2. Event-stream search
// ---------------------------------------------------------------------------

export type QueuedCommandMatch = {
  /** Hex agentId extracted from `<task-id>`. */
  agentId: string;
  /** `<tool-use-id>` this queued_command is bound to. */
  toolUseId: string;
  /** Index of the matching queued_command attachment in the event array. */
  eventIndex: number;
};

/**
 * Finds the `queued_command` attachment whose `<tool-use-id>` equals
 * `toolUseId`. Returns `null` when no such attachment is present or its
 * `<task-id>` fails the hex regex.
 */
export function findQueuedCommandForToolUse(
  events: unknown[],
  toolUseId: string
): QueuedCommandMatch | null {
  for (let i = 0; i < events.length; i++) {
    const evt = events[i] as Record<string, unknown> | null;
    if (!evt || typeof evt !== 'object') continue;
    if (evt['type'] !== 'attachment') continue;
    const attachment = evt['attachment'] as Record<string, unknown> | undefined;
    if (!attachment || attachment['type'] !== 'queued_command') continue;
    const prompt = attachment['prompt'];
    if (typeof prompt !== 'string') continue;
    const boundId = extractToolUseIdFromQueuedCommand(prompt);
    if (boundId !== toolUseId) continue;
    const agentId = extractAgentIdFromQueuedCommand(prompt);
    if (!agentId) return null;
    return { agentId, toolUseId, eventIndex: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve `<claudeProjectsDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl`
 * and ensure the resulting absolute path stays under `claudeProjectsDir`.
 * Rejects path traversal via `..` or absolute agentIds.
 */
function safeResolveChildPath(
  claudeProjectsDir: string,
  parentSessionId: string,
  agentId: string,
  extension: 'jsonl' | 'meta.json'
): string | null {
  const rootAbs = resolve(claudeProjectsDir);
  const target = resolve(rootAbs, parentSessionId, 'subagents', `agent-${agentId}.${extension}`);
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (!target.startsWith(rootWithSep)) return null;
  return target;
}

// ---------------------------------------------------------------------------
// 4. Full join
// ---------------------------------------------------------------------------

export type JoinOpts = {
  /** Parent Session (mutated — subagent spans get childSpanIds populated). */
  session: Session;
  /** Raw events from the parent JSONL (post-parseJsonl). */
  events: unknown[];
  /**
   * Absolute path to `~/.claude/projects/<sanitized-cwd>`. All child
   * transcript reads are constrained to stay under this directory.
   */
  claudeProjectsDir: string;
  /**
   * Runs the L1.1 assembler on child events. Injected so callers can pass the
   * same pre-computed `tokenOf`/`redactOf` closures they used for the parent.
   */
  assemble: (childEvents: unknown[]) => Session;
  /** Optional warning sink — defaults to `console.warn`. */
  onWarn?: (msg: string) => void;
};

export type JoinOutcome = {
  /** The (mutated) parent Session. */
  session: Session;
  /** agentIds whose child JSONL we successfully stitched in. */
  joinedAgentIds: string[];
};

/**
 * Stitch child subagent transcripts into a parent Session.
 *
 * For each `subagent` span on `session.spans`, we:
 *   1. Look up the originating `tool_use.id` from `span.metadata.toolUseId`.
 *   2. Find the matching `queued_command` attachment in `events`.
 *   3. Extract `agentId` via `<task-id>` regex.
 *   4. Load and assemble the child JSONL (depth=1 only).
 *   5. Splice the child's spans into the parent Session at the position of
 *      the subagent span, and populate `parentSpan.childSpanIds`.
 *
 * If any of those steps fails (no toolUseId, no queued_command, missing file,
 * path-traversal guard, parse error), we emit a warning and leave the span
 * unchanged — never throw.
 */
export function joinSubagentsIntoSession(opts: JoinOpts): JoinOutcome {
  const { session, events, claudeProjectsDir, assemble } = opts;
  // Only emit warnings when PEEK_DEBUG is set. Real Claude Code sessions
  // routinely contain tool_use IDs that predate queued_command attachments
  // (older sessions, tool calls from before this schema) — those are not
  // user-actionable errors and flood the CLI on startup.
  const warn =
    opts.onWarn ??
    ((m: string) => {
      if (process.env.PEEK_DEBUG) console.warn(`[peek-trace] ${m}`);
    });
  const joinedAgentIds: string[] = [];

  // Snapshot the initial subagent spans — splicing mutates session.spans so we
  // can't iterate it directly.
  const subagentSpans = session.spans.filter((s) => s.type === 'subagent');

  for (const parentSpan of subagentSpans) {
    const toolUseId =
      parentSpan.metadata && typeof parentSpan.metadata['toolUseId'] === 'string'
        ? (parentSpan.metadata['toolUseId'] as string)
        : undefined;
    if (!toolUseId) {
      warn(`subagent span ${parentSpan.id} has no toolUseId metadata; skipping join`);
      continue;
    }

    const match = findQueuedCommandForToolUse(events, toolUseId);
    if (!match) {
      warn(
        `no queued_command attachment found for tool_use_id=${toolUseId} (span ${parentSpan.id})`
      );
      continue;
    }

    const { agentId } = match;

    const childPath = safeResolveChildPath(claudeProjectsDir, session.id, agentId, 'jsonl');
    if (!childPath) {
      warn(
        `refusing child path outside claudeProjectsDir (agentId=${agentId}, sessionId=${session.id})`
      );
      continue;
    }

    if (!existsSync(childPath)) {
      warn(
        `child transcript missing for agentId=${agentId} at ${childPath}; emitting empty childSpanIds`
      );
      continue;
    }

    // Sibling meta.json is optional.
    let agentType: string | undefined;
    let description: string | undefined;
    const metaPath = safeResolveChildPath(claudeProjectsDir, session.id, agentId, 'meta.json');
    if (metaPath && existsSync(metaPath)) {
      try {
        const metaRaw = readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw);
        if (meta && typeof meta === 'object') {
          if (typeof (meta as Record<string, unknown>)['agentType'] === 'string') {
            agentType = (meta as Record<string, unknown>)['agentType'] as string;
          }
          if (typeof (meta as Record<string, unknown>)['description'] === 'string') {
            description = (meta as Record<string, unknown>)['description'] as string;
          }
        }
      } catch (err) {
        warn(
          `failed to read meta.json for agentId=${agentId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Read + parse child JSONL.
    let childContent: string;
    try {
      // Guard against absurdly large files — cap at 64 MiB.
      const st = statSync(childPath);
      if (st.size > 64 * 1024 * 1024) {
        warn(`child transcript too large for agentId=${agentId} (${st.size} bytes); skipping`);
        continue;
      }
      childContent = readFileSync(childPath, 'utf8');
    } catch (err) {
      warn(
        `failed to read child transcript for agentId=${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    const { events: childEvents } = parseJsonl(childContent);

    let childSession: Session;
    try {
      childSession = assemble(childEvents);
    } catch (err) {
      warn(
        `failed to assemble child session for agentId=${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    // Depth=1 — clear any childSpanIds on grandchild subagent spans so we
    // don't accidentally claim we recursed.
    for (const childSpan of childSession.spans) {
      if (childSpan.type === 'subagent') {
        childSpan.childSpanIds = [];
      }
    }

    // Re-parent any child spans that pointed at UUIDs that don't exist in the
    // child session (e.g. pointed at the parent's tool_use uuid). Anything
    // that previously had no resolvable parent now dangles under parentSpan.
    const childSpanIdsSet = new Set(childSession.spans.map((s) => s.id));
    for (const childSpan of childSession.spans) {
      if (childSpan.parentSpanId && !childSpanIdsSet.has(childSpan.parentSpanId)) {
        childSpan.parentSpanId = parentSpan.id;
      }
    }

    // Splice child spans into the parent span array immediately AFTER the
    // parent subagent span (preserves timeline ordering).
    const insertIdx = session.spans.indexOf(parentSpan);
    if (insertIdx < 0) continue; // should not happen
    session.spans.splice(insertIdx + 1, 0, ...childSession.spans);

    // Populate parent childSpanIds with the TOP-LEVEL child spans: those
    // whose parentSpanId is either unset or not a sibling within the child set.
    // (After the dangling-rewrite above, those now point at parentSpan.id, so
    // any span whose parentSpanId === parentSpan.id is a top-level child.)
    const topLevelChildIds: string[] = [];
    for (const childSpan of childSession.spans) {
      if (!childSpan.parentSpanId || childSpan.parentSpanId === parentSpan.id) {
        topLevelChildIds.push(childSpan.id);
        // Make the link explicit in both directions.
        childSpan.parentSpanId = parentSpan.id;
      }
    }
    parentSpan.childSpanIds = topLevelChildIds;

    // Merge child ledger into parent ledger.
    for (const entry of childSession.ledger) {
      session.ledger.push(entry);
    }
    // And child turns — child turns keep their own ids, flagged with the
    // agentId so downstream consumers can distinguish them if they care.
    for (const turn of childSession.turns) {
      session.turns.push(turn);
    }

    // Surface meta on the parent span.
    parentSpan.metadata = {
      ...(parentSpan.metadata ?? {}),
      agentId,
      ...(agentType !== undefined ? { agentType } : {}),
      ...(description !== undefined ? { agentDescription: description } : {}),
      childTranscriptPath: childPath,
    };

    joinedAgentIds.push(agentId);
  }

  return { session, joinedAgentIds };
}
