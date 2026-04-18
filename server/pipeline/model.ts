/**
 * Session assembler for peek-trace.
 *
 * Takes raw JSONL events (from `parseJsonl`) and constructs a structured
 * `Session` object composed of turns, action spans, and a ledger of content
 * entries. All emitted fields use camelCase — raw snake_case usage fields
 * from Claude Code JSONL are converted at this boundary.
 */

export type SpanType =
  | 'user_prompt'
  | 'thinking'
  | 'api_call'
  | 'tool_call'
  | 'subagent'
  | 'hook'
  | 'skill'
  | 'memory'
  | 'system'
  | 'attachment'
  | 'unknown';

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens?: number;
  iterationCount?: number;
};

export type Turn = {
  id: string;
  index: number;
  startTs?: string;
  endTs?: string;
  usage?: TurnUsage;
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

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'TaskCreate']);

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isUserPromptEvent(evt: any): boolean {
  if (evt?.type !== 'user') return false;
  const content = evt?.message?.content;
  // String-shaped content = direct user prompt. Array-of-tool_result = tool response, not a turn.
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    // If ALL blocks are tool_result, this is a tool response, not a user prompt.
    const hasNonToolResult = content.some(
      (b: any) => b && typeof b === 'object' && b.type !== 'tool_result'
    );
    return hasNonToolResult;
  }
  return false;
}

function blockSpanType(blockType: string, blockName?: string): SpanType {
  switch (blockType) {
    case 'text':
      return 'api_call';
    case 'thinking':
      return 'thinking';
    case 'tool_use':
      if (blockName && SUBAGENT_TOOL_NAMES.has(blockName)) return 'subagent';
      return 'tool_call';
    case 'tool_result':
      return 'tool_call';
    default:
      return 'unknown';
  }
}

function eventSpanType(evtType: string): SpanType {
  switch (evtType) {
    case 'user':
      return 'user_prompt';
    case 'assistant':
      return 'api_call';
    case 'system':
      return 'system';
    case 'attachment':
      return 'attachment';
    default:
      return 'unknown';
  }
}

export function assembleSession(events: any[], ctx: AssembleContext): Session {
  const turns: Turn[] = [];
  const spans: ActionSpan[] = [];
  const ledger: LedgerEntry[] = [];

  // Pick first event with useful session metadata.
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
  // Track message.id -> turnId on which we've already credited usage, so we don't double-count.
  const countedMessageIds = new Set<string>();
  let ledgerCounter = 0;

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;

    // --- Turn boundary: user prompt events start a new turn. ---------------
    if (isUserPromptEvent(evt)) {
      const turn: Turn = {
        id: evt.uuid ?? `turn-${turnIndex}`,
        index: turnIndex++,
        startTs: evt.timestamp,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };
      turns.push(turn);
      currentTurn = turn;

      if (!session.firstPrompt && typeof evt.message?.content === 'string') {
        session.firstPrompt = evt.message.content;
      }
      if (!session.startTs) session.startTs = evt.timestamp;

      // Emit a user_prompt span for the prompt itself.
      const promptSpan: ActionSpan = {
        id: evt.uuid ?? `user-prompt-${turnIndex}`,
        type: 'user_prompt',
        turnId: turn.id,
        parentSpanId: evt.parentUuid ?? undefined,
        childSpanIds: [],
        startTs: evt.timestamp,
        tokensConsumed: 0,
      };
      spans.push(promptSpan);

      // Ledger entry for prompt content.
      const contentStr = stringifyContent(evt.message?.content);
      const tokens = ctx.tokenOf ? ctx.tokenOf(contentStr) : 0;
      const redact = ctx.redactOf?.(contentStr);
      const entry: LedgerEntry = {
        id: `ledger-${ledgerCounter++}`,
        turnId: turn.id,
        introducedBySpanId: promptSpan.id,
        source: 'user_prompt',
        tokens,
        contentRedacted: redact?.redacted ?? contentStr,
        sourceOffset: redact?.sourceOffset,
        ts: evt.timestamp,
      };
      ledger.push(entry);
      promptSpan.tokensConsumed += tokens;

      continue;
    }

    // --- Assistant events: one span per content block. ---------------------
    if (evt.type === 'assistant') {
      if (!currentTurn) {
        // Assistant without a user turn — synthesize an implicit turn.
        const turn: Turn = {
          id: `implicit-${turnIndex}`,
          index: turnIndex++,
          startTs: evt.timestamp,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        };
        turns.push(turn);
        currentTurn = turn;
      }

      // Credit usage to the current turn ONCE per message.id (CC splits one
      // assistant message across multiple events that share usage).
      const usage = evt.message?.usage;
      const messageId: string | undefined = evt.message?.id;
      if (usage && currentTurn.usage && messageId && !countedMessageIds.has(messageId)) {
        currentTurn.usage.inputTokens += Number(usage.input_tokens ?? 0);
        currentTurn.usage.outputTokens += Number(usage.output_tokens ?? 0);
        currentTurn.usage.cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0);
        currentTurn.usage.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
        if (typeof usage.thinking_tokens === 'number') {
          currentTurn.usage.thinkingTokens =
            (currentTurn.usage.thinkingTokens ?? 0) + usage.thinking_tokens;
        }
        countedMessageIds.add(messageId);
      } else if (usage && currentTurn.usage && !messageId) {
        // No messageId to dedupe on — credit once per event (best effort).
        currentTurn.usage.inputTokens += Number(usage.input_tokens ?? 0);
        currentTurn.usage.outputTokens += Number(usage.output_tokens ?? 0);
        currentTurn.usage.cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0);
        currentTurn.usage.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
      }

      currentTurn.endTs = evt.timestamp;
      session.endTs = evt.timestamp;

      const blocks: any[] = Array.isArray(evt.message?.content) ? evt.message.content : [];

      // One span per assistant event (covers all its blocks — usually 1).
      // Span type derived from the first meaningful block.
      const firstBlock = blocks[0];
      const spanType: SpanType = firstBlock
        ? blockSpanType(firstBlock.type, firstBlock.name)
        : eventSpanType(evt.type);

      const span: ActionSpan = {
        id: evt.uuid,
        type: spanType,
        name: firstBlock?.name,
        turnId: currentTurn.id,
        parentSpanId: evt.parentUuid ?? undefined,
        childSpanIds: [],
        startTs: evt.timestamp,
        tokensConsumed: 0,
      };
      spans.push(span);

      // Ledger entry per content block.
      for (const block of blocks) {
        const contentStr =
          typeof block?.text === 'string'
            ? block.text
            : typeof block?.thinking === 'string'
              ? block.thinking
              : stringifyContent(block?.input ?? block);
        const tokens = ctx.tokenOf ? ctx.tokenOf(contentStr) : 0;
        const redact = ctx.redactOf?.(contentStr);
        const entry: LedgerEntry = {
          id: `ledger-${ledgerCounter++}`,
          turnId: currentTurn.id,
          introducedBySpanId: span.id,
          source: block?.type ?? 'assistant',
          tokens,
          contentRedacted: redact?.redacted ?? contentStr,
          sourceOffset: redact?.sourceOffset,
          ts: evt.timestamp,
        };
        ledger.push(entry);
        span.tokensConsumed += tokens;
      }

      continue;
    }

    // --- Everything else: emit a span with a reasonable type. --------------
    const spanType = eventSpanType(evt.type ?? 'unknown');
    const span: ActionSpan = {
      id: evt.uuid ?? `span-${spans.length}`,
      type: spanType === 'user_prompt' ? 'unknown' : spanType,
      turnId: currentTurn?.id,
      parentSpanId: evt.parentUuid ?? undefined,
      childSpanIds: [],
      startTs: evt.timestamp,
      tokensConsumed: 0,
    };
    // Unknown-type events should reliably report 'unknown' rather than
    // mapping through eventSpanType's default.
    if (!['user', 'assistant', 'system', 'attachment'].includes(evt.type)) {
      span.type = 'unknown';
    }
    spans.push(span);
  }

  // --- Subagent join: enrich subagent spans with footer metadata. ----------
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

  // --- Build childSpanIds from parentSpanId. -------------------------------
  const spanById = new Map(spans.map((s) => [s.id, s]));
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const parent = spanById.get(span.parentSpanId);
    if (parent) parent.childSpanIds.push(span.id);
  }

  return session;
}
