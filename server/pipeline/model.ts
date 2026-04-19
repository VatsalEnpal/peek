/**
 * Session assembler for peek-trace (v0.2 — block-level dispatch).
 *
 * Takes raw JSONL events (from `parseJsonl`) and produces a structured
 * `Session`. Walks `message.content[]` block-by-block per §DATA-MAPPING in
 * the v0.2 builder plan — each content block becomes one ActionSpan whose
 * type is derived from `block.type` (+ `block.name` for tool_use).
 *
 * All emitted fields use camelCase — raw snake_case usage fields from CC
 * JSONL are converted at this boundary.
 */

export type SpanType =
  // Human prompt (turn-starting `user` event with text content).
  | 'user_prompt'
  // Assistant text block (model reply).
  | 'api_call'
  // Assistant thinking block (rendered ONLY when tokens > 500).
  | 'thinking_block'
  // Generic tool_use (Read, Write, Edit, Bash, Grep, Glob, WebFetch,
  // WebSearch, TodoWrite, and any unclassified tool).
  | 'tool_call'
  // tool_use with name === 'Agent' (also legacy 'Task' / 'TaskCreate').
  | 'subagent'
  // tool_use with name === 'Skill' OR attachment.type === 'skill_listing'.
  | 'skill_activation'
  // tool_use with name starting `mcp__`.
  | 'mcp_call'
  // Read tool whose file_path matches `*/memory/*`.
  | 'memory_read'
  // attachment hook_success / hook_additional_context OR system
  // stop_hook_summary.
  | 'hook_fire'
  // Fallback — preserves raw event under metadata.rawEvent.
  | 'unknown';

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens?: number;
  iterationCount?: number;
};

/**
 * Per-turn reconciliation snapshot (L1.5). Populated by `reconcileTurnTokens`
 * after assembly: compares the model's reported usage against the sum of the
 * turn's span `tokensConsumed`. Observability-only — never fatal.
 */
export type TurnReconciliation = {
  match: boolean;
  drift: number;
  parentReported: number;
  childSum: number;
  threshold: number;
};

export type Turn = {
  id: string;
  index: number;
  startTs?: string;
  endTs?: string;
  usage?: TurnUsage;
  /** L1.5 — runtime token reconciliation result for this turn. */
  reconciliation?: TurnReconciliation;
};

export type ActionSpan = {
  id: string;
  type: SpanType;
  name?: string;
  turnId?: string;
  parentSpanId?: string;
  childSpanIds: string[];
  startTs?: string;
  endTs?: string;
  durationMs?: number;
  tokensConsumed: number;
  inputs?: unknown;
  outputs?: unknown;
  metadata?: Record<string, unknown>;
};

export type LedgerSourceOffset = {
  file: string;
  /**
   * 1-based source line number in the JSONL file. Present when the
   * import-orchestrator plumbs through the line index; optional on legacy
   * callers.
   */
  line?: number;
  byteStart: number;
  byteEnd: number;
  sourceLineHash: string;
};

export type LedgerEntry = {
  id: string;
  turnId: string;
  introducedBySpanId?: string;
  source?: string;
  tokens: number;
  contentRedacted?: string;
  sourceOffset?: LedgerSourceOffset;
  /**
   * 64-char hex SHA-256 of the raw JSONL source line this entry originated
   * from. Mirrors `sourceOffset.sourceLineHash` for callers that want the
   * hash at the top level (per plan §LedgerEntry lines 143-150).
   */
  sourceLineHash?: string;
  ts?: string;
};

export type Session = {
  id: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
  ccVersion?: string;
  entrypoint?: string;
  firstPrompt?: string;
  startTs?: string;
  endTs?: string;
  turns: Turn[];
  spans: ActionSpan[];
  ledger: LedgerEntry[];
};

export type AssembleContext = {
  sourceFile: string;
  subagentJoinResults?: Array<{
    agentId: string;
    footer: { totalTokens: number; toolUses?: number; durationMs?: number };
    sidecarEvents: unknown[];
    sidecarStatus: 'ok' | 'missing' | 'truncated';
  }>;
  tokenOf?: (content: string) => number;
  redactOf?: (content: string) => { redacted: string; sourceOffset?: LedgerSourceOffset };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERIC_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'MultiEdit',
  'BashOutput',
  'KillShell',
  'NotebookEdit',
  'TaskUpdate',
  'TaskList',
]);

// The plan renames the old 'Task' tool to 'Agent'. Keep legacy aliases
// ('Task', 'TaskCreate') so older fixtures still classify as subagent.
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'TaskCreate']);

const THINKING_TOKEN_THRESHOLD = 500;

// L12: Claude Code wraps slash commands as
//   <command-message>peek_start</command-message> <command-name>/peek_start</command-name>
// inside the user stream. These tags should never become a session's
// firstPrompt / card title. Mirror the regex in server/identity/session-label
// so stripping is consistent at every layer.
const COMMAND_TAG_RE =
  /<(?:local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/(?:local-command-caveat|command-name|command-message|command-args)>/g;

function isCommandOnly(promptText: string): boolean {
  return promptText.replace(COMMAND_TAG_RE, '').trim().length === 0;
}

/** Extract the command name from a command-only prompt, e.g. "/peek_start". */
function extractCommandName(promptText: string): string | undefined {
  const m = promptText.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
  if (m && m[1]) return m[1];
  const m2 = promptText.match(/<command-message>\s*([^<\s]+)\s*<\/command-message>/);
  if (m2 && m2[1]) return `/${m2[1]}`;
  return undefined;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  // Content blocks from tool_result can be an array of {type:'text',text:'…'}.
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
        else if (typeof b.content === 'string') parts.push(b.content);
        else {
          try {
            parts.push(JSON.stringify(b));
          } catch {
            parts.push(String(b));
          }
        }
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isMemoryPath(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  return /\/memory\//i.test(p);
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1);
}

/** Block → SpanType + default name. `name` may be refined by caller. */
function classifyAssistantBlock(block: any): { type: SpanType; name?: string } {
  const t = block?.type;
  if (t === 'text') return { type: 'api_call' };
  if (t === 'thinking') return { type: 'thinking_block', name: 'thinking' };
  if (t === 'tool_use') {
    const toolName: string = typeof block?.name === 'string' ? block.name : 'tool';
    if (SUBAGENT_TOOL_NAMES.has(toolName)) {
      const subType =
        typeof block?.input?.subagent_type === 'string' ? block.input.subagent_type : 'unknown';
      return { type: 'subagent', name: `Agent: ${subType}` };
    }
    if (toolName === 'Skill') {
      const skill = typeof block?.input?.skill === 'string' ? block.input.skill : 'unknown';
      return { type: 'skill_activation', name: skill };
    }
    if (toolName.startsWith('mcp__')) {
      return { type: 'mcp_call', name: toolName };
    }
    if (toolName === 'Read' && isMemoryPath(block?.input?.file_path)) {
      return { type: 'memory_read', name: basename(block.input.file_path as string) };
    }
    // Any other tool → generic tool_call.
    return { type: 'tool_call', name: toolName };
  }
  return { type: 'unknown' };
}

function isUserPromptEvent(evt: any): boolean {
  if (evt?.type !== 'user') return false;
  const content = evt?.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    // If ALL blocks are tool_result, this is a tool response, not a prompt.
    const hasNonToolResult = content.some(
      (b: any) => b && typeof b === 'object' && b.type !== 'tool_result'
    );
    return hasNonToolResult;
  }
  return false;
}

function classifyAttachment(evt: any): { type: SpanType; name?: string } {
  const atype = evt?.attachment?.type;
  if (atype === 'hook_success' || atype === 'hook_additional_context') {
    const hookName = evt.attachment?.hookName ?? 'hook';
    const hookEvent = evt.attachment?.hookEvent ?? atype;
    return { type: 'hook_fire', name: `${hookName}:${hookEvent}` };
  }
  if (atype === 'skill_listing') {
    const count = evt.attachment?.skillCount ?? 0;
    return { type: 'skill_activation', name: `skill_listing (${count} skills)` };
  }
  return { type: 'unknown', name: typeof atype === 'string' ? atype : 'attachment' };
}

function classifySystem(evt: any): { type: SpanType; name?: string } {
  if (evt?.subtype === 'stop_hook_summary') {
    return { type: 'hook_fire', name: 'stop_hook_summary' };
  }
  return { type: 'unknown', name: typeof evt?.subtype === 'string' ? evt.subtype : 'system' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function assembleSession(events: any[], ctx: AssembleContext): Session {
  const turns: Turn[] = [];
  const spans: ActionSpan[] = [];
  const ledger: LedgerEntry[] = [];

  const metaEvt = events.find((e) => e && (e.sessionId || e.cwd || e.gitBranch));
  const sessionId: string = metaEvt?.sessionId ?? 'session-unknown';

  const session: Session = {
    id: sessionId,
    cwd: metaEvt?.cwd,
    gitBranch: metaEvt?.gitBranch,
    ccVersion: metaEvt?.version,
    entrypoint: metaEvt?.entrypoint,
    turns,
    spans,
    ledger,
  };

  if (events.length === 0) return session;

  let currentTurn: Turn | undefined;
  let turnIndex = 0;
  // Track message.id -> usage already credited, so we never double-count when
  // CC splits one assistant message across multiple events with shared usage.
  const countedMessageIds = new Set<string>();
  let ledgerCounter = 0;
  let spanCounter = 0;

  // L12 firstPrompt state: only lock in session.firstPrompt once we see a
  // real (non-command) user prompt. Until then, remember the most recent
  // command name so we can fall back to it if every prompt turns out to be
  // a slash command.
  let firstPromptLocked = false;
  let lastCommandName: string | undefined;

  // Index tool_use_id → ActionSpan so we can later attach tool_result outputs.
  const toolUseIdToSpan = new Map<string, ActionSpan>();

  const tokenOf = ctx.tokenOf ?? (() => 0);

  function addLedger(
    turnId: string,
    introducedBySpanId: string | undefined,
    source: string,
    contentStr: string,
    ts: string | undefined
  ): number {
    const tokens = tokenOf(contentStr);
    const redact = ctx.redactOf?.(contentStr);
    const entry: LedgerEntry = {
      id: `ledger-${ledgerCounter++}`,
      turnId,
      introducedBySpanId,
      source,
      tokens,
      contentRedacted: redact?.redacted ?? contentStr,
      sourceOffset: redact?.sourceOffset,
      ts,
    };
    // Mirror the per-line SHA-256 to the top level so downstream consumers can
    // pick it up without drilling into sourceOffset (plan §LedgerEntry).
    if (redact?.sourceOffset?.sourceLineHash) {
      entry.sourceLineHash = redact.sourceOffset.sourceLineHash;
    }
    ledger.push(entry);
    return tokens;
  }

  function openTurn(evt: any, implicit: boolean): Turn {
    const turn: Turn = {
      id: evt?.uuid ?? `turn-${turnIndex}`,
      index: turnIndex++,
      startTs: evt?.timestamp,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
    if (implicit) turn.id = `implicit-${turn.index}`;
    turns.push(turn);
    return turn;
  }

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;

    // -----------------------------------------------------------------------
    // 1) User event — may be a prompt (starts a turn) OR a tool_result carrier.
    // -----------------------------------------------------------------------
    if (evt.type === 'user') {
      // Attach tool_result content to previously-opened tool spans, if any.
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && block.type === 'tool_result') {
            const target = toolUseIdToSpan.get(block.tool_use_id);
            if (target) {
              const outStr = stringifyContent(block.content);
              // Redact before persisting into span.outputs (A4 — no plaintext
              // may land in the on-disk outputs_json column).
              target.outputs = ctx.redactOf?.(outStr)?.redacted ?? outStr;
              // Record tool_result in ledger (content entering context).
              if (target.turnId) {
                const tokens = addLedger(
                  target.turnId,
                  target.id,
                  'tool_result',
                  outStr,
                  evt.timestamp
                );
                target.tokensConsumed += tokens;
              }
            }
          }
        }
      }

      if (!isUserPromptEvent(evt)) continue;

      const turn = openTurn(evt, false);
      currentTurn = turn;

      const promptText = typeof content === 'string' ? content : stringifyContent(content);
      // Route plaintext through the session's redactOf closure before any of
      // it lands in a persisted field. firstPrompt, span.inputs and the
      // ledger entry are ALL dumped by Store.dumpAsText — any raw secret
      // here breaks the A4 "no plaintext in DB" contract (v0.2 L5 fix).
      const promptRedacted = ctx.redactOf?.(promptText)?.redacted ?? promptText;

      // L12: prefer the first real user prompt as session.firstPrompt.
      // Slash commands arrive as `<command-message>…</command-message>` XML
      // and should NOT become the session's card title. If the first few
      // prompts are all commands, keep a running `lastCommandName` so we
      // have something to fall back to at end-of-events.
      if (!firstPromptLocked) {
        if (isCommandOnly(promptText)) {
          const name = extractCommandName(promptText);
          if (name) lastCommandName = name;
          // Seed firstPrompt with the command name so pre-commit inspectors
          // still see something sensible — it'll be overwritten as soon as a
          // real prompt shows up.
          if (!session.firstPrompt && lastCommandName) {
            session.firstPrompt = lastCommandName;
          }
        } else {
          session.firstPrompt = promptRedacted;
          firstPromptLocked = true;
        }
      }
      if (!session.startTs) session.startTs = evt.timestamp;

      const promptSpan: ActionSpan = {
        id: evt.uuid ?? `span-${spanCounter++}`,
        type: 'user_prompt',
        turnId: turn.id,
        parentSpanId: evt.parentUuid ?? undefined,
        childSpanIds: [],
        startTs: evt.timestamp,
        tokensConsumed: 0,
        inputs: promptRedacted,
      };
      spans.push(promptSpan);

      const tokens = addLedger(turn.id, promptSpan.id, 'user_prompt', promptText, evt.timestamp);
      promptSpan.tokensConsumed += tokens;
      continue;
    }

    // -----------------------------------------------------------------------
    // 2) Assistant event — one span per content block.
    // -----------------------------------------------------------------------
    if (evt.type === 'assistant') {
      if (!currentTurn) currentTurn = openTurn(evt, true);

      // --- Credit usage once per message.id. ---
      const usage = evt.message?.usage;
      const messageId: string | undefined = evt.message?.id;
      const alreadyCounted = messageId ? countedMessageIds.has(messageId) : false;
      if (usage && currentTurn.usage && !alreadyCounted) {
        // Plan line 161: SUM over iterations[] when present → those ARE the
        // true per-turn totals. Otherwise fall back to the top-level counters.
        const iters = Array.isArray(usage.iterations) ? usage.iterations : null;
        let inp = 0,
          outp = 0,
          cc = 0,
          cr = 0,
          thk = 0;
        if (iters && iters.length > 0) {
          for (const it of iters) {
            inp += Number(it?.input_tokens ?? 0);
            outp += Number(it?.output_tokens ?? 0);
            cc += Number(it?.cache_creation_input_tokens ?? 0);
            cr += Number(it?.cache_read_input_tokens ?? 0);
            if (typeof it?.thinking_tokens === 'number') thk += it.thinking_tokens;
          }
          currentTurn.usage.iterationCount = (currentTurn.usage.iterationCount ?? 0) + iters.length;
        } else {
          inp = Number(usage.input_tokens ?? 0);
          outp = Number(usage.output_tokens ?? 0);
          cc = Number(usage.cache_creation_input_tokens ?? 0);
          cr = Number(usage.cache_read_input_tokens ?? 0);
          if (typeof usage.thinking_tokens === 'number') thk = usage.thinking_tokens;
          currentTurn.usage.iterationCount = (currentTurn.usage.iterationCount ?? 0) + 1;
        }
        currentTurn.usage.inputTokens += inp;
        currentTurn.usage.outputTokens += outp;
        currentTurn.usage.cacheCreationTokens += cc;
        currentTurn.usage.cacheReadTokens += cr;
        if (thk > 0) {
          currentTurn.usage.thinkingTokens = (currentTurn.usage.thinkingTokens ?? 0) + thk;
        }
        if (messageId) countedMessageIds.add(messageId);
      }

      currentTurn.endTs = evt.timestamp;
      session.endTs = evt.timestamp;

      const blocks: any[] = Array.isArray(evt.message?.content) ? evt.message.content : [];

      // Emit ONE span per content block. When an assistant event has multiple
      // blocks, all but the first get synthetic IDs derived from evt.uuid.
      let blockIdx = 0;
      for (const block of blocks) {
        const classified = classifyAssistantBlock(block);

        // For thinking blocks we suppress the span entirely when under
        // threshold — they are still recorded in the ledger (content entered
        // context) so token accounting stays honest.
        let contentStr: string;
        if (block?.type === 'text') contentStr = typeof block.text === 'string' ? block.text : '';
        else if (block?.type === 'thinking')
          contentStr = typeof block.thinking === 'string' ? block.thinking : '';
        else if (block?.type === 'tool_use') contentStr = stringifyContent(block.input ?? {});
        else contentStr = stringifyContent(block);

        const blockTokens = tokenOf(contentStr);

        if (block?.type === 'thinking' && blockTokens <= THINKING_TOKEN_THRESHOLD) {
          // No rendered span — still ledger.
          if (currentTurn)
            addLedger(currentTurn.id, undefined, 'thinking', contentStr, evt.timestamp);
          blockIdx++;
          continue;
        }

        const spanId =
          blockIdx === 0 ? (evt.uuid ?? `span-${spanCounter++}`) : `${evt.uuid}::${blockIdx}`;

        const span: ActionSpan = {
          id: spanId,
          type: classified.type,
          name: classified.name,
          turnId: currentTurn.id,
          parentSpanId: evt.parentUuid ?? undefined,
          childSpanIds: [],
          startTs: evt.timestamp,
          tokensConsumed: 0,
        };

        // Populate inputs/outputs. Route plaintext through redactOf so no raw
        // secret ever lands in `inputs_json` / `outputs_json` on disk (A4).
        const outputRedacted = ctx.redactOf?.(contentStr)?.redacted ?? contentStr;
        if (block?.type === 'text') {
          span.outputs = outputRedacted;
        } else if (block?.type === 'thinking') {
          span.outputs = outputRedacted;
        } else if (block?.type === 'tool_use') {
          // Tool-use inputs are a structured object (filename, command, etc.)
          // We redact the stringified form and store that so persisted JSON
          // never reveals secret flags/args.
          const inputStr = stringifyContent(block.input ?? {});
          const inputRedacted = ctx.redactOf?.(inputStr)?.redacted ?? inputStr;
          span.inputs = inputRedacted;
          if (typeof block.id === 'string') {
            toolUseIdToSpan.set(block.id, span);
            span.metadata = { ...(span.metadata ?? {}), toolUseId: block.id };
          }
        }

        spans.push(span);

        const tokens = addLedger(
          currentTurn.id,
          span.id,
          block?.type ?? 'assistant',
          contentStr,
          evt.timestamp
        );
        span.tokensConsumed += tokens;

        blockIdx++;
      }

      continue;
    }

    // -----------------------------------------------------------------------
    // 3) Attachment events (hook_success, skill_listing, …).
    // -----------------------------------------------------------------------
    if (evt.type === 'attachment') {
      const classified = classifyAttachment(evt);
      const span: ActionSpan = {
        id: evt.uuid ?? `span-${spanCounter++}`,
        type: classified.type,
        name: classified.name,
        turnId: currentTurn?.id,
        parentSpanId: evt.parentUuid ?? undefined,
        childSpanIds: [],
        startTs: evt.timestamp,
        tokensConsumed: 0,
      };

      const atype = evt.attachment?.type;
      const redactStr = (s: unknown): unknown =>
        typeof s === 'string' ? (ctx.redactOf?.(s)?.redacted ?? s) : s;
      if (atype === 'hook_success' || atype === 'hook_additional_context') {
        // Redact every string field of the hook payload individually so
        // secrets in stdout/stderr never land in persisted outputs_json (A4).
        span.outputs = {
          command: redactStr(evt.attachment?.command),
          content: redactStr(evt.attachment?.content),
          stdout: redactStr(evt.attachment?.stdout),
          stderr: redactStr(evt.attachment?.stderr),
          exitCode: evt.attachment?.exitCode,
        };
      } else if (atype === 'skill_listing') {
        span.outputs = redactStr(evt.attachment?.content);
      } else {
        span.metadata = { ...(span.metadata ?? {}), rawEvent: evt };
      }

      spans.push(span);

      if (currentTurn) {
        const contentStr = stringifyContent(span.outputs ?? span.name ?? '');
        const tokens = addLedger(currentTurn.id, span.id, 'attachment', contentStr, evt.timestamp);
        span.tokensConsumed += tokens;
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // 4) System events (stop_hook_summary, bridge_status, informational, …).
    // -----------------------------------------------------------------------
    if (evt.type === 'system') {
      const classified = classifySystem(evt);
      const span: ActionSpan = {
        id: evt.uuid ?? `span-${spanCounter++}`,
        type: classified.type,
        name: classified.name,
        turnId: currentTurn?.id,
        parentSpanId: evt.parentUuid ?? undefined,
        childSpanIds: [],
        startTs: evt.timestamp,
        tokensConsumed: 0,
      };
      if (evt.subtype === 'stop_hook_summary') {
        span.outputs = {
          hookCount: evt.hookCount,
          hookInfos: evt.hookInfos,
          hookErrors: evt.hookErrors,
          preventedContinuation: evt.preventedContinuation,
          stopReason: evt.stopReason,
        };
      } else {
        span.metadata = { ...(span.metadata ?? {}), rawEvent: evt };
      }
      spans.push(span);
      continue;
    }

    // -----------------------------------------------------------------------
    // 5) Anything else → unknown span preserving raw event.
    // -----------------------------------------------------------------------
    const span: ActionSpan = {
      id: evt.uuid ?? `span-${spanCounter++}`,
      type: 'unknown',
      name: typeof evt.type === 'string' ? evt.type : undefined,
      turnId: currentTurn?.id,
      parentSpanId: evt.parentUuid ?? undefined,
      childSpanIds: [],
      startTs: evt.timestamp,
      tokensConsumed: 0,
      metadata: { rawEvent: evt },
    };
    spans.push(span);
  }

  // --- Subagent join: enrich subagent spans with footer metadata (legacy). -
  if (ctx.subagentJoinResults && ctx.subagentJoinResults.length > 0) {
    const joinById = new Map(ctx.subagentJoinResults.map((r) => [r.agentId, r]));
    for (const span of spans) {
      if (span.type !== 'subagent') continue;
      const join = joinById.get(span.id);
      if (!join) continue;
      span.metadata = {
        ...(span.metadata ?? {}),
        reportedTotalTokens: join.footer.totalTokens,
        subagentToolUses: join.footer.toolUses,
        subagentDurationMs: join.footer.durationMs,
        sidecarStatus: join.sidecarStatus,
      };
    }
  }

  // --- Per-turn context_carry ledger entry (A2 reconciliation, v0.2 L5). ---
  // The per-block ledger entries cover content that appears as a literal event
  // in the JSONL (user prompts, tool_results, attachments, assistant blocks).
  // But `turn.usage.{input,cacheCreation,cacheRead}` also includes system
  // prompt, tool catalog, skill metadata, and prior-turn cache reads — context
  // Claude saw but that is NOT represented as events in this turn.
  //
  // A2 pins the per-turn ledger sum to within 2% of reported usage. Rather
  // than try to synthesise per-fragment entries for every piece of hidden
  // context (which we cannot recover from the JSONL), we emit ONE synthetic
  // "context_carry" ledger entry per turn whose tokens equal the gap between
  // reported-read usage and the per-block sum. Semantically: "content Claude
  // saw this turn that did not arrive as a new event".
  for (const turn of turns) {
    if (!turn.usage) continue;
    const reportedRead =
      (Number(turn.usage.inputTokens) || 0) +
      (Number(turn.usage.cacheCreationTokens) || 0) +
      (Number(turn.usage.cacheReadTokens) || 0);
    if (reportedRead <= 0) continue;
    let currentSum = 0;
    for (const entry of ledger) {
      if (entry.turnId === turn.id) currentSum += entry.tokens ?? 0;
    }
    const gap = reportedRead - currentSum;
    if (gap <= 0) continue;
    ledger.push({
      id: `ledger-${ledgerCounter++}`,
      turnId: turn.id,
      source: 'context_carry',
      tokens: gap,
      ts: turn.startTs,
    });
  }

  // --- Build childSpanIds from parentSpanId. -------------------------------
  // Note: L1.2 (subagent-joiner) will populate Agent span childSpanIds from
  // the agent-<agentId>.jsonl sidecar. Here we only wire the parentUuid chain.
  const spanById = new Map(spans.map((s) => [s.id, s]));
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const parent = spanById.get(span.parentSpanId);
    if (parent) parent.childSpanIds.push(span.id);
  }
  // Silence unused-var lint for GENERIC_TOOL_NAMES — reserved for future
  // refinement of the tool_call catalog; referenced in a no-op here.
  void GENERIC_TOOL_NAMES;

  return session;
}
