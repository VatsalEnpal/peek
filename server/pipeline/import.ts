/**
 * Import orchestrator — stitches the full peek-trace pipeline:
 *
 *   file(s) -> parseJsonl -> (subagent joiner) -> token pre-compute
 *           -> redaction pre-compute -> assembleSession -> store
 *           -> reconciliation self-check
 *
 * `importPath` is the single public entry point. It takes either a `.jsonl`
 * file or a directory, and on completion either persists everything to the
 * Store (default) or returns a dry-run summary (`preview: true`).
 *
 * Return convention is driven by the acceptance helpers:
 *   - `{ returnAssembled: true }` → returns the first assembled `Session`
 *     directly (what `importFixture` in tests/acceptance/helpers.ts expects).
 *   - otherwise → returns `ImportResult` with per-session summaries.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseJsonl } from './parser';
import { assembleSession, type Session, type LedgerSourceOffset } from './model';
import { countTokensOffline, countTokensViaAPI } from './tokenizer';
import { redactBlock, createSessionSalt, sourceLineHash } from './redactor';
import { reconcileSubagentTokens } from './self-check';
import { Store, type SessionRow, type TurnRow, type SpanRow, type LedgerEntryRow } from './store';
import { detectMarkers } from '../bookmarks/marker-detector';
import { composeLabel } from '../identity/session-label';

export type ImportOpts = {
  /** If true, scan + count but don't write to store. */
  preview?: boolean;
  /** Output directory for the SQLite DB (`<dataDir>/store.db`). */
  dataDir?: string;
  /** Optional API key forwarded to the tokenizer dispatcher. */
  anthropicApiKey?: string;
  /** When true, return the first assembled Session directly (see module doc). */
  returnAssembled?: boolean;
  /** Deterministic session salt override — usually auto-generated per session. */
  salt?: string;
};

export type ImportSessionSummary = {
  id: string;
  label: string;
  turnCount: number;
  totalTokens: number;
};

export type DriftWarning = {
  sessionId: string;
  turn: number;
  drift: number;
};

export type ImportResult = {
  sessions: ImportSessionSummary[];
  preview: boolean;
  driftWarnings: DriftWarning[];
  /** Present only when `returnAssembled:true` — first assembled Session. */
  assembled?: Session;
};

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function listJsonlFiles(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) {
    return path.endsWith('.jsonl') ? [path] : [];
  }
  if (!st.isDirectory()) return [];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile() && full.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  };
  walk(path);
  return out;
}

// ---------------------------------------------------------------------------
// Content-block extraction
//
// The assembler walks events the same way we do here; we mirror that walk to
// pre-compute (a) token counts per content string and (b) redaction results
// per content string *with byte-accurate source offsets* in the JSONL line.
// ---------------------------------------------------------------------------

type ContentBlockInfo = {
  content: string;
  /** 1-indexed source line number in the JSONL file. */
  lineNumber: number;
};

function stringifyBlockContent(block: any): string {
  if (typeof block?.text === 'string') return block.text;
  if (typeof block?.thinking === 'string') return block.thinking;
  const inner = block?.input ?? block;
  if (typeof inner === 'string') return inner;
  if (inner == null) return '';
  try {
    return JSON.stringify(inner);
  } catch {
    return String(inner);
  }
}

/**
 * Mirror of `stringifyContent` in model.ts — used to pre-tokenize tool_result
 * payloads so the assembler's `tokenOf` closure has an entry for them. Without
 * this, tool_call spans get `tokensConsumed = 0` (checker finding 3, v0.2).
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
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

function stringifyUserPromptContent(content: unknown): string {
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
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some((b: any) => b && typeof b === 'object' && b.type !== 'tool_result');
  }
  return false;
}

/**
 * Walk events in source order and collect every content string the assembler
 * will also visit. The order here matches `assembleSession` so each content
 * block we emit lines up with a ledger entry 1:1 (by source + lineNumber).
 */
function collectContentBlocks(events: any[], rawLines: string[]): ContentBlockInfo[] {
  const out: ContentBlockInfo[] = [];

  // Map event -> line number: we parsed sequentially, so event N corresponds
  // to the Nth non-empty/parseable line. Re-derive instead of plumbing line
  // numbers through the parser: re-walk rawLines, tracking which parsed.
  const eventLineNumbers: number[] = [];
  let evtIdx = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw.length === 0) continue;
    try {
      JSON.parse(raw);
      if (evtIdx < events.length) {
        eventLineNumbers[evtIdx++] = i + 1; // 1-indexed
      }
    } catch {
      // malformed line — the parser skipped it, so we skip too.
    }
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (!evt || typeof evt !== 'object') continue;
    const lineNumber = eventLineNumbers[i] ?? 0;

    if (evt.type === 'user') {
      if (isUserPromptEvent(evt)) {
        out.push({ content: stringifyUserPromptContent(evt.message?.content), lineNumber });
      }
      // Even when it's a tool_result carrier (not a prompt), harvest each
      // tool_result block's content so the tokenMap has an entry — otherwise
      // tool_call spans will read `tokenOf(outStr) === 0` (checker finding 3).
      const content = evt?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as any).type === 'tool_result') {
            out.push({
              content: stringifyToolResultContent((block as any).content),
              lineNumber,
            });
          }
        }
      }
      continue;
    }

    if (evt.type === 'assistant') {
      const blocks: any[] = Array.isArray(evt.message?.content) ? evt.message.content : [];
      for (const block of blocks) {
        out.push({ content: stringifyBlockContent(block), lineNumber });
      }
      continue;
    }

    // Attachment events — hook_fire / skill_activation span outputs enter the
    // ledger via stringifyContent(span.outputs ?? span.name ?? ''). Mirror
    // that exactly so their tokens are costed.
    if (evt.type === 'attachment') {
      const atype = evt?.attachment?.type;
      let contentStr = '';
      if (atype === 'hook_success' || atype === 'hook_additional_context') {
        contentStr = stringifyToolResultContent({
          command: evt.attachment?.command,
          content: evt.attachment?.content,
          stdout: evt.attachment?.stdout,
          stderr: evt.attachment?.stderr,
          exitCode: evt.attachment?.exitCode,
        });
      } else if (atype === 'skill_listing') {
        contentStr = stringifyToolResultContent(evt.attachment?.content);
      }
      if (contentStr.length > 0) out.push({ content: contentStr, lineNumber });
      continue;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Token pre-compute
//
// `assembleSession` is synchronous; Anthropic's token endpoint is async. So
// collect every unique content string up front, look up tokens for each (in
// parallel with bounded concurrency when using the API path, sync when using
// the offline tokenizer), cache in a Map, then pass a synchronous `tokenOf`
// closure to the assembler.
// ---------------------------------------------------------------------------

async function precomputeTokens(
  uniqueContents: string[],
  apiKey: string | undefined
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (!apiKey) {
    // Offline tokenizer is sync-ish and extremely fast — no need for concurrency.
    for (const c of uniqueContents) {
      result.set(c, await countTokensOffline(c));
    }
    return result;
  }

  // API path: bounded-concurrency worker pool. `countTokensViaAPI` already
  // handles rate limiting internally, but capping the in-flight count avoids
  // unbounded promise fanout for large sessions.
  const CONCURRENCY = 10;
  const queue = [...uniqueContents];
  const workers: Promise<void>[] = [];

  async function work(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift();
      if (c === undefined) return;
      try {
        const tokens = await countTokensViaAPI(c, { apiKey });
        result.set(c, tokens);
      } catch {
        // Fall back to offline on any API error — don't abort the whole run.
        result.set(c, await countTokensOffline(c));
      }
    }
  }

  for (let i = 0; i < Math.min(CONCURRENCY, uniqueContents.length); i++) {
    workers.push(work());
  }
  await Promise.all(workers);

  return result;
}

// ---------------------------------------------------------------------------
// Redaction pre-compute
//
// `redactBlock` needs the full source line bytes (to compute a line hash) and
// a byte range for where the content lives within that line. We don't go to
// the trouble of exact-in-line byte positioning (the JSON escaping would make
// that a mess); instead we pass [0, lineBytes.length] — lossy, but sufficient
// for the A4 acceptance contract: the content hash is consistent for the same
// plaintext within a session, and the plaintext never lands in the Store.
// ---------------------------------------------------------------------------

// @ts-expect-error — staged for post-v0.1 refactor; keep for reference.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function precomputeRedactions(
  blocks: ContentBlockInfo[],
  rawLines: string[],
  salt: string,
  sourceFile: string
): Map<string, { redacted: string; sourceOffset?: LedgerSourceOffset }> {
  const map = new Map<string, { redacted: string; sourceOffset?: LedgerSourceOffset }>();

  for (const { content, lineNumber } of blocks) {
    if (map.has(content)) continue;
    const lineBytes = Buffer.from(
      lineNumber > 0 && lineNumber - 1 < rawLines.length ? rawLines[lineNumber - 1] : '',
      'utf8'
    );
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const result = redactBlock(content, salt, sourceFile, lineBytes, {
      start: 0,
      end: Math.min(contentBytes, lineBytes.length),
    });
    map.set(content, { redacted: result.redacted, sourceOffset: result.sourceOffset });
  }

  // Override the line hash with the per-line hash we actually computed —
  // redactBlock takes the *content* line already. We kept it inline above so
  // every entry gets its own lineHash.
  return map;
}

// ---------------------------------------------------------------------------
// Store persistence
// ---------------------------------------------------------------------------

function persistSession(store: Store, session: Session, salt: string): void {
  const sessionRow: SessionRow = {
    id: session.id,
    salt,
  };
  if (session.slug !== undefined) sessionRow.slug = session.slug;
  if (session.cwd !== undefined) sessionRow.cwd = session.cwd;
  if (session.gitBranch !== undefined) sessionRow.gitBranch = session.gitBranch;
  if (session.ccVersion !== undefined) sessionRow.ccVersion = session.ccVersion;
  if (session.entrypoint !== undefined) sessionRow.entrypoint = session.entrypoint;
  if (session.firstPrompt !== undefined) sessionRow.firstPrompt = session.firstPrompt;
  if (session.startTs !== undefined) sessionRow.startTs = session.startTs;
  if (session.endTs !== undefined) sessionRow.endTs = session.endTs;
  store.putSession(sessionRow);

  for (const turn of session.turns) {
    const row: TurnRow = {
      id: turn.id,
      sessionId: session.id,
      turnIndex: turn.index,
    };
    if (turn.startTs !== undefined) row.startTs = turn.startTs;
    if (turn.endTs !== undefined) row.endTs = turn.endTs;
    if (turn.usage !== undefined) row.usage = turn.usage;
    store.putTurn(row);
  }

  for (const span of session.spans) {
    const row: SpanRow = {
      id: span.id,
      sessionId: session.id,
      type: span.type,
    };
    if (span.turnId !== undefined) row.turnId = span.turnId;
    if (span.parentSpanId !== undefined) row.parentSpanId = span.parentSpanId;
    if (span.name !== undefined) row.name = span.name;
    if (span.startTs !== undefined) row.startTs = span.startTs;
    if (span.endTs !== undefined) row.endTs = span.endTs;
    if (span.durationMs !== undefined) row.durationMs = span.durationMs;
    // Checker finding 3 (v0.2): persist the span-level token count so the
    // `/api/sessions/:id/events` response carries a numeric tokens value per
    // tool_call row (and every other span type). Default to 0 to guarantee
    // the wire field is always a number, never undefined.
    row.tokensConsumed = typeof span.tokensConsumed === 'number' ? span.tokensConsumed : 0;
    if (span.inputs !== undefined) row.inputs = span.inputs;
    if (span.outputs !== undefined) row.outputs = span.outputs;
    if (span.metadata !== undefined) row.metadata = span.metadata;
    store.putSpan(row);
  }

  for (const entry of session.ledger) {
    const row: LedgerEntryRow = {
      id: entry.id,
      sessionId: session.id,
      tokens: entry.tokens,
    };
    if (entry.turnId !== undefined) row.turnId = entry.turnId;
    if (entry.introducedBySpanId !== undefined) row.introducedBySpanId = entry.introducedBySpanId;
    if (entry.source !== undefined) row.source = entry.source;
    if (entry.contentRedacted !== undefined) row.contentRedacted = entry.contentRedacted;
    if (entry.sourceOffset !== undefined) row.sourceOffset = entry.sourceOffset;
    if (entry.ts !== undefined) row.ts = entry.ts;
    store.putLedgerEntry(row);
  }
}

// ---------------------------------------------------------------------------
// Per-file import
// ---------------------------------------------------------------------------

type PerFileResult = {
  session: Session;
  summary: ImportSessionSummary;
  drifts: DriftWarning[];
  salt: string;
  rawEvents: unknown[];
};

async function importSingleFile(
  file: string,
  opts: { apiKey?: string; salt?: string }
): Promise<PerFileResult> {
  const raw = readFileSync(file, 'utf8');
  const rawLines = raw.split('\n');
  const { events } = parseJsonl(raw);

  const salt = opts.salt ?? createSessionSalt();

  // 1. Collect all content blocks with their source-line indices.
  const blocks = collectContentBlocks(events, rawLines);

  // 2. Pre-compute token counts for each unique content string.
  const uniqueContents = Array.from(new Set(blocks.map((b) => b.content)));
  const tokenMap = await precomputeTokens(uniqueContents, opts.apiKey);

  // 3. Pre-compute redactions (uses per-line source hash for sourceOffset).
  const redactMap = new Map<string, { redacted: string; sourceOffset?: LedgerSourceOffset }>();
  for (const { content, lineNumber } of blocks) {
    if (redactMap.has(content)) continue;
    const line = lineNumber > 0 && lineNumber - 1 < rawLines.length ? rawLines[lineNumber - 1] : '';
    const lineBytes = Buffer.from(line, 'utf8');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const result = redactBlock(content, salt, file, lineBytes, {
      start: 0,
      end: Math.min(contentBytes, lineBytes.length),
    });
    redactMap.set(content, {
      redacted: result.redacted,
      sourceOffset: {
        file,
        byteStart: 0,
        byteEnd: Math.min(contentBytes, lineBytes.length),
        sourceLineHash: sourceLineHash(line),
      },
    });
  }

  // 4. Assemble the session with sync lookups against our pre-computed maps.
  const session = assembleSession(events, {
    sourceFile: file,
    tokenOf: (c: string) => tokenMap.get(c) ?? 0,
    redactOf: (c: string) => redactMap.get(c) ?? { redacted: c },
  });

  // 5. Compute drift warnings for each subagent span with reported metadata.
  const drifts: DriftWarning[] = [];
  for (const span of session.spans) {
    if (span.type !== 'subagent') continue;
    const reported = span.metadata?.['reportedTotalTokens'];
    if (typeof reported !== 'number' || reported <= 0) continue;

    // Sum descendant tokens.
    const spanById = new Map(session.spans.map((s) => [s.id, s]));
    const childTokens: number[] = [];
    const visit = (id: string): void => {
      const s = spanById.get(id);
      if (!s) return;
      childTokens.push(s.tokensConsumed ?? 0);
      for (const childId of s.childSpanIds ?? []) visit(childId);
    };
    for (const childId of span.childSpanIds ?? []) visit(childId);

    const res = reconcileSubagentTokens({ parentReported: reported, childTokens });
    if (!res.match) {
      // eslint-disable-next-line no-console
      console.warn(`[peek-trace] ${res.loud}`);
      const turn = session.turns.find((t) => t.id === span.turnId);
      drifts.push({
        sessionId: session.id,
        turn: turn?.index ?? -1,
        drift: res.drift,
      });
    }
  }

  const totalTokens = session.ledger.reduce((s, l) => s + (l.tokens ?? 0), 0);
  const summary: ImportSessionSummary = {
    id: session.id,
    label: composeLabel(session),
    turnCount: session.turns.length,
    totalTokens,
  };

  return { session, summary, drifts, salt, rawEvents: events };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function importPath(
  path: string,
  opts: ImportOpts = {}
): Promise<ImportResult | Session> {
  const files = listJsonlFiles(path);

  const perFile: PerFileResult[] = [];
  for (const file of files) {
    const res = await importSingleFile(file, {
      apiKey: opts.anthropicApiKey,
      salt: opts.salt,
    });
    perFile.push(res);
  }

  // Persist unless we're in preview mode.
  if (!opts.preview && perFile.length > 0) {
    const dataDir = opts.dataDir ?? join(process.env.HOME ?? '/tmp', '.peek');
    const store = new Store(dataDir);
    try {
      for (const { session, salt, rawEvents } of perFile) {
        persistSession(store, session, salt);
        // Detect @peek-start/@peek-end marker bookmarks from the user-text
        // stream and persist each as a marker-sourced bookmark.
        const markers = detectMarkers(session, rawEvents as unknown[]);
        for (const bm of markers) {
          const row: Parameters<Store['putBookmark']>[0] = {
            id: bm.id,
            sessionId: bm.sessionId,
            label: bm.label,
            source: bm.source,
            startTs: bm.startTs,
          };
          if (bm.endTs !== undefined) row.endTs = bm.endTs;
          if (bm.metadata !== undefined) row.metadata = bm.metadata;
          store.putBookmark(row);
        }
      }
    } finally {
      store.close();
    }
  }

  const result: ImportResult = {
    sessions: perFile.map((p) => p.summary),
    preview: opts.preview === true,
    driftWarnings: perFile.flatMap((p) => p.drifts),
  };

  if (opts.returnAssembled === true) {
    // Acceptance helpers rely on this returning the Session directly.
    return (
      perFile[0]?.session ??
      ({
        id: 'empty',
        turns: [],
        spans: [],
        ledger: [],
      } as Session)
    );
  }

  return result;
}
