/**
 * SQLite-backed store for peek-trace sessions, turns, spans, ledger entries,
 * and bookmarks.
 *
 * All public APIs are camelCase; snake_case stays inside SQL. JSON columns
 * transparently encode/decode objects (metadata, usage, sourceOffset, inputs,
 * outputs) so callers only ever deal with typed TS shapes.
 *
 * Schema versioning: on construction, the store either initialises a fresh
 * DB (creating all tables and stamping `_meta.schema_version = SCHEMA_VERSION`)
 * or validates an existing DB's recorded schema_version. A mismatch throws
 * immediately to prevent silent reads of an incompatible layout.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import Database, { type Database as BetterSqliteDatabase, type Statement } from 'better-sqlite3';

export const SCHEMA_VERSION = '2';

export type SessionRow = {
  id: string;
  slug?: string;
  cwd?: string;
  gitBranch?: string;
  ccVersion?: string;
  entrypoint?: string;
  firstPrompt?: string;
  startTs?: string;
  endTs?: string;
  salt: string;
  metadata?: Record<string, unknown>;
};

export type TurnRow = {
  id: string;
  sessionId: string;
  turnIndex: number;
  startTs?: string;
  endTs?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    thinkingTokens?: number;
    iterationCount?: number;
  };
};

export type SpanRow = {
  id: string;
  sessionId: string;
  turnId?: string;
  parentSpanId?: string;
  type: string;
  name?: string;
  startTs?: string;
  endTs?: string;
  durationMs?: number;
  /**
   * Sum of token cost attributable to this span. Populated on the in-memory
   * Span by the assembler and persisted here so `/api/sessions/:id/events`
   * can surface a numeric token count per row. Added in schema v2 (checker
   * finding 3 — v0.2 blocking).
   *
   * Exposed on the wire as both `tokensConsumed` (canonical) and `tokens`
   * (alias) — the two have historically been used interchangeably.
   */
  tokensConsumed?: number;
  tokens?: number;
  inputs?: unknown;
  outputs?: unknown;
  metadata?: Record<string, unknown>;
};

export type LedgerEntryRow = {
  id: string;
  sessionId: string;
  turnId?: string;
  introducedBySpanId?: string;
  source?: string;
  tokens?: number;
  contentRedacted?: string;
  sourceOffset?: {
    file: string;
    byteStart: number;
    byteEnd: number;
    sourceLineHash: string;
  };
  ts?: string;
};

export type BookmarkRow = {
  id: string;
  sessionId: string;
  label?: string;
  source?: string;
  startTs?: string;
  endTs?: string;
  metadata?: Record<string, unknown>;
};

export type ListEventsOpts = {
  start?: string;
  end?: string;
  types?: string[];
  limit?: number;
};

export type StoreEvent = (SpanRow & { kind: 'span' }) | (LedgerEntryRow & { kind: 'ledger' });

const DDL = `
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  slug TEXT,
  cwd TEXT,
  git_branch TEXT,
  cc_version TEXT,
  entrypoint TEXT,
  first_prompt TEXT,
  start_ts TEXT,
  end_ts TEXT,
  salt TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL,
  start_ts TEXT,
  end_ts TEXT,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE TABLE IF NOT EXISTS action_spans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  parent_span_id TEXT,
  type TEXT NOT NULL,
  name TEXT,
  start_ts TEXT,
  end_ts TEXT,
  duration_ms INTEGER,
  tokens_consumed INTEGER,
  inputs_json TEXT,
  outputs_json TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_session ON action_spans(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_turn ON action_spans(turn_id);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON action_spans(parent_span_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  introduced_by_span_id TEXT REFERENCES action_spans(id),
  source TEXT,
  tokens INTEGER,
  content_redacted TEXT,
  source_offset_json TEXT,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ledger_turn ON ledger_entries(turn_id);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  label TEXT,
  source TEXT,
  start_ts TEXT,
  end_ts TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_session ON bookmarks(session_id);
`;

function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function decodeJson<T>(raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  return JSON.parse(raw) as T;
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function undef<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

type SessionDbRow = {
  id: string;
  slug: string | null;
  cwd: string | null;
  git_branch: string | null;
  cc_version: string | null;
  entrypoint: string | null;
  first_prompt: string | null;
  start_ts: string | null;
  end_ts: string | null;
  salt: string;
  metadata_json: string | null;
};

type SpanDbRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  parent_span_id: string | null;
  type: string;
  name: string | null;
  start_ts: string | null;
  end_ts: string | null;
  duration_ms: number | null;
  tokens_consumed: number | null;
  inputs_json: string | null;
  outputs_json: string | null;
  metadata_json: string | null;
};

type LedgerDbRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  introduced_by_span_id: string | null;
  source: string | null;
  tokens: number | null;
  content_redacted: string | null;
  source_offset_json: string | null;
  ts: string | null;
};

type BookmarkDbRow = {
  id: string;
  session_id: string;
  label: string | null;
  source: string | null;
  start_ts: string | null;
  end_ts: string | null;
  metadata_json: string | null;
};

function hydrateSession(row: SessionDbRow): SessionRow {
  const out: SessionRow = { id: row.id, salt: row.salt };
  const slug = undef(row.slug);
  if (slug !== undefined) out.slug = slug;
  const cwd = undef(row.cwd);
  if (cwd !== undefined) out.cwd = cwd;
  const gitBranch = undef(row.git_branch);
  if (gitBranch !== undefined) out.gitBranch = gitBranch;
  const ccVersion = undef(row.cc_version);
  if (ccVersion !== undefined) out.ccVersion = ccVersion;
  const entrypoint = undef(row.entrypoint);
  if (entrypoint !== undefined) out.entrypoint = entrypoint;
  const firstPrompt = undef(row.first_prompt);
  if (firstPrompt !== undefined) out.firstPrompt = firstPrompt;
  const startTs = undef(row.start_ts);
  if (startTs !== undefined) out.startTs = startTs;
  const endTs = undef(row.end_ts);
  if (endTs !== undefined) out.endTs = endTs;
  const metadata = decodeJson<Record<string, unknown>>(row.metadata_json);
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}

function hydrateSpan(row: SpanDbRow): SpanRow {
  const out: SpanRow = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
  };
  const turnId = undef(row.turn_id);
  if (turnId !== undefined) out.turnId = turnId;
  const parentSpanId = undef(row.parent_span_id);
  if (parentSpanId !== undefined) out.parentSpanId = parentSpanId;
  const name = undef(row.name);
  if (name !== undefined) out.name = name;
  const startTs = undef(row.start_ts);
  if (startTs !== undefined) out.startTs = startTs;
  const endTs = undef(row.end_ts);
  if (endTs !== undefined) out.endTs = endTs;
  const durationMs = undef(row.duration_ms);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const tokensConsumed = undef(row.tokens_consumed);
  if (tokensConsumed !== undefined) {
    out.tokensConsumed = tokensConsumed;
    // Mirror to `tokens` alias so wire readers that expect either name work.
    out.tokens = tokensConsumed;
  }
  const inputs = decodeJson<unknown>(row.inputs_json);
  if (inputs !== undefined) out.inputs = inputs;
  const outputs = decodeJson<unknown>(row.outputs_json);
  if (outputs !== undefined) out.outputs = outputs;
  const metadata = decodeJson<Record<string, unknown>>(row.metadata_json);
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}

function hydrateLedger(row: LedgerDbRow): LedgerEntryRow {
  const out: LedgerEntryRow = { id: row.id, sessionId: row.session_id };
  const turnId = undef(row.turn_id);
  if (turnId !== undefined) out.turnId = turnId;
  const introducedBySpanId = undef(row.introduced_by_span_id);
  if (introducedBySpanId !== undefined) out.introducedBySpanId = introducedBySpanId;
  const source = undef(row.source);
  if (source !== undefined) out.source = source;
  const tokens = undef(row.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  const contentRedacted = undef(row.content_redacted);
  if (contentRedacted !== undefined) out.contentRedacted = contentRedacted;
  const sourceOffset = decodeJson<LedgerEntryRow['sourceOffset']>(row.source_offset_json);
  if (sourceOffset !== undefined) out.sourceOffset = sourceOffset;
  const ts = undef(row.ts);
  if (ts !== undefined) out.ts = ts;
  return out;
}

function hydrateBookmark(row: BookmarkDbRow): BookmarkRow {
  const out: BookmarkRow = { id: row.id, sessionId: row.session_id };
  const label = undef(row.label);
  if (label !== undefined) out.label = label;
  const source = undef(row.source);
  if (source !== undefined) out.source = source;
  const startTs = undef(row.start_ts);
  if (startTs !== undefined) out.startTs = startTs;
  const endTs = undef(row.end_ts);
  if (endTs !== undefined) out.endTs = endTs;
  const metadata = decodeJson<Record<string, unknown>>(row.metadata_json);
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}

export class Store {
  private readonly db: BetterSqliteDatabase;
  private readonly stmts: {
    insertSession: Statement;
    getSession: Statement;
    listSessions: Statement;
    insertTurn: Statement;
    insertSpan: Statement;
    insertLedger: Statement;
    insertBookmark: Statement;
    listBookmarksAll: Statement;
    listBookmarksBySession: Statement;
    listSpansBySession: Statement;
    listLedgerBySession: Statement;
    listTurnsBySession: Statement;
  };

  constructor(dbPath: string) {
    // Accept three shapes:
    //   - ':memory:' → in-memory DB, passed through verbatim.
    //   - path ending in '.db' → used as the SQLite file path directly.
    //   - anything else → treated as a directory that should contain 'store.db'.
    //     The directory is created on demand so callers can pass an arbitrary
    //     dataDir from tests/config without pre-creating it.
    let resolved = dbPath;
    if (dbPath !== ':memory:') {
      const looksLikeDbFile = dbPath.endsWith('.db');
      const existsAsDir = existsSync(dbPath) && statSync(dbPath).isDirectory();
      if (!looksLikeDbFile || existsAsDir) {
        // Treat as directory.
        if (!existsSync(dbPath)) {
          mkdirSync(dbPath, { recursive: true });
        }
        resolved = join(dbPath, 'store.db');
      }
    }

    this.db = new Database(resolved);

    // WAL is unavailable for in-memory DBs; skip there to avoid noisy warnings.
    if (resolved !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');

    // If _meta table exists and records a schema version, validate it before
    // creating anything. This also catches the "partially initialised" case
    // where _meta exists but the row is missing (treated as fresh).
    const metaExists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'`)
      .get() as { name: string } | undefined;

    if (metaExists) {
      const row = this.db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      if (row && row.value !== SCHEMA_VERSION) {
        this.db.close();
        throw new Error(`schema version mismatch: expected ${SCHEMA_VERSION}, got ${row.value}`);
      }
    }

    this.db.exec('BEGIN');
    try {
      this.db.exec(DDL);
      this.db
        .prepare(`INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', ?)`)
        .run(SCHEMA_VERSION);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw err;
    }

    this.stmts = {
      insertSession: this.db.prepare(
        `INSERT OR REPLACE INTO sessions (
          id, slug, cwd, git_branch, cc_version, entrypoint, first_prompt,
          start_ts, end_ts, salt, metadata_json
        ) VALUES (
          @id, @slug, @cwd, @git_branch, @cc_version, @entrypoint, @first_prompt,
          @start_ts, @end_ts, @salt, @metadata_json
        )`
      ),
      getSession: this.db.prepare(`SELECT * FROM sessions WHERE id = ?`),
      listSessions: this.db.prepare(
        `SELECT * FROM sessions ORDER BY COALESCE(start_ts, '') DESC, id ASC`
      ),
      insertTurn: this.db.prepare(
        `INSERT OR REPLACE INTO turns (
          id, session_id, turn_index, start_ts, end_ts, usage_json
        ) VALUES (
          @id, @session_id, @turn_index, @start_ts, @end_ts, @usage_json
        )`
      ),
      insertSpan: this.db.prepare(
        `INSERT OR REPLACE INTO action_spans (
          id, session_id, turn_id, parent_span_id, type, name,
          start_ts, end_ts, duration_ms, tokens_consumed,
          inputs_json, outputs_json, metadata_json
        ) VALUES (
          @id, @session_id, @turn_id, @parent_span_id, @type, @name,
          @start_ts, @end_ts, @duration_ms, @tokens_consumed,
          @inputs_json, @outputs_json, @metadata_json
        )`
      ),
      insertLedger: this.db.prepare(
        `INSERT OR REPLACE INTO ledger_entries (
          id, session_id, turn_id, introduced_by_span_id, source, tokens,
          content_redacted, source_offset_json, ts
        ) VALUES (
          @id, @session_id, @turn_id, @introduced_by_span_id, @source, @tokens,
          @content_redacted, @source_offset_json, @ts
        )`
      ),
      insertBookmark: this.db.prepare(
        `INSERT OR REPLACE INTO bookmarks (
          id, session_id, label, source, start_ts, end_ts, metadata_json
        ) VALUES (
          @id, @session_id, @label, @source, @start_ts, @end_ts, @metadata_json
        )`
      ),
      listBookmarksAll: this.db.prepare(
        `SELECT * FROM bookmarks ORDER BY COALESCE(start_ts, '') ASC, id ASC`
      ),
      listBookmarksBySession: this.db.prepare(
        `SELECT * FROM bookmarks WHERE session_id = ? ORDER BY COALESCE(start_ts, '') ASC, id ASC`
      ),
      listSpansBySession: this.db.prepare(
        `SELECT * FROM action_spans WHERE session_id = ? ORDER BY COALESCE(start_ts, '') ASC, id ASC`
      ),
      listLedgerBySession: this.db.prepare(
        `SELECT * FROM ledger_entries WHERE session_id = ? ORDER BY COALESCE(ts, '') ASC, id ASC`
      ),
      listTurnsBySession: this.db.prepare(
        `SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC, id ASC`
      ),
    };
  }

  /**
   * L2.4 CRITICAL — fetch every Turn row for a session, hydrated with its
   * `usage` JSON. The CONTEXT gauge route emits these as `turn` wire events
   * so the UI can compute real per-turn context pressure (not span content
   * sums, which under-report by ~40x on real Claude Code sessions).
   */
  listTurns(sessionId: string): TurnRow[] {
    type TurnDbRow = {
      id: string;
      session_id: string;
      turn_index: number;
      start_ts: string | null;
      end_ts: string | null;
      usage_json: string | null;
    };
    const rows = this.stmts.listTurnsBySession.all(sessionId) as TurnDbRow[];
    return rows.map((r) => {
      const out: TurnRow = {
        id: r.id,
        sessionId: r.session_id,
        turnIndex: r.turn_index,
      };
      const startTs = undef(r.start_ts);
      if (startTs !== undefined) out.startTs = startTs;
      const endTs = undef(r.end_ts);
      if (endTs !== undefined) out.endTs = endTs;
      const usage = decodeJson<TurnRow['usage']>(r.usage_json);
      if (usage !== undefined) out.usage = usage;
      return out;
    });
  }

  close(): void {
    this.db.close();
  }

  putSession(s: SessionRow): void {
    this.stmts.insertSession.run({
      id: s.id,
      slug: nullable(s.slug),
      cwd: nullable(s.cwd),
      git_branch: nullable(s.gitBranch),
      cc_version: nullable(s.ccVersion),
      entrypoint: nullable(s.entrypoint),
      first_prompt: nullable(s.firstPrompt),
      start_ts: nullable(s.startTs),
      end_ts: nullable(s.endTs),
      salt: s.salt,
      metadata_json: encodeJson(s.metadata),
    });
  }

  getSession(id: string): SessionRow | null {
    const row = this.stmts.getSession.get(id) as SessionDbRow | undefined;
    if (!row) return null;
    return hydrateSession(row);
  }

  listSessions(): SessionRow[] {
    const rows = this.stmts.listSessions.all() as SessionDbRow[];
    return rows.map(hydrateSession);
  }

  putTurn(t: TurnRow): void {
    this.stmts.insertTurn.run({
      id: t.id,
      session_id: t.sessionId,
      turn_index: t.turnIndex,
      start_ts: nullable(t.startTs),
      end_ts: nullable(t.endTs),
      usage_json: encodeJson(t.usage),
    });
  }

  putSpan(s: SpanRow): void {
    // Prefer explicit tokensConsumed, fall back to tokens alias if provided.
    const tokens =
      typeof s.tokensConsumed === 'number'
        ? s.tokensConsumed
        : typeof s.tokens === 'number'
          ? s.tokens
          : undefined;
    this.stmts.insertSpan.run({
      id: s.id,
      session_id: s.sessionId,
      turn_id: nullable(s.turnId),
      parent_span_id: nullable(s.parentSpanId),
      type: s.type,
      name: nullable(s.name),
      start_ts: nullable(s.startTs),
      end_ts: nullable(s.endTs),
      duration_ms: nullable(s.durationMs),
      tokens_consumed: nullable(tokens),
      inputs_json: encodeJson(s.inputs),
      outputs_json: encodeJson(s.outputs),
      metadata_json: encodeJson(s.metadata),
    });
  }

  putLedgerEntry(e: LedgerEntryRow): void {
    this.stmts.insertLedger.run({
      id: e.id,
      session_id: e.sessionId,
      turn_id: nullable(e.turnId),
      introduced_by_span_id: nullable(e.introducedBySpanId),
      source: nullable(e.source),
      tokens: nullable(e.tokens),
      content_redacted: nullable(e.contentRedacted),
      source_offset_json: encodeJson(e.sourceOffset),
      ts: nullable(e.ts),
    });
  }

  putBookmark(b: BookmarkRow): void {
    this.stmts.insertBookmark.run({
      id: b.id,
      session_id: b.sessionId,
      label: nullable(b.label),
      source: nullable(b.source),
      start_ts: nullable(b.startTs),
      end_ts: nullable(b.endTs),
      metadata_json: encodeJson(b.metadata),
    });
  }

  listBookmarks(sessionId?: string): BookmarkRow[] {
    const rows = sessionId
      ? (this.stmts.listBookmarksBySession.all(sessionId) as BookmarkDbRow[])
      : (this.stmts.listBookmarksAll.all() as BookmarkDbRow[]);
    return rows.map(hydrateBookmark);
  }

  listEvents(sessionId: string, opts: ListEventsOpts = {}): StoreEvent[] {
    const spanRows = this.stmts.listSpansBySession.all(sessionId) as SpanDbRow[];
    const ledgerRows = this.stmts.listLedgerBySession.all(sessionId) as LedgerDbRow[];

    const spans: StoreEvent[] = spanRows.map((r) => ({
      ...hydrateSpan(r),
      kind: 'span' as const,
    }));
    const ledger: StoreEvent[] = ledgerRows.map((r) => ({
      ...hydrateLedger(r),
      kind: 'ledger' as const,
    }));

    let events: StoreEvent[] = [...spans, ...ledger];

    if (opts.types && opts.types.length > 0) {
      const typeSet = new Set(opts.types);
      events = events.filter((e) =>
        e.kind === 'span' ? typeSet.has(e.type) : typeSet.has('ledger')
      );
    }

    if (opts.start !== undefined) {
      const start = opts.start;
      events = events.filter((e) => {
        const ts = e.kind === 'span' ? e.startTs : e.ts;
        return ts === undefined || ts >= start;
      });
    }
    if (opts.end !== undefined) {
      const end = opts.end;
      events = events.filter((e) => {
        const ts = e.kind === 'span' ? e.startTs : e.ts;
        return ts === undefined || ts <= end;
      });
    }

    events.sort((a, b) => {
      const aTs = (a.kind === 'span' ? a.startTs : a.ts) ?? '';
      const bTs = (b.kind === 'span' ? b.startTs : b.ts) ?? '';
      if (aTs !== bTs) return aTs < bTs ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    if (opts.limit !== undefined && opts.limit >= 0) {
      events = events.slice(0, opts.limit);
    }

    return events;
  }

  /**
   * Concatenate every user-visible text field across all tables into one big
   * string. Used by acceptance tests (A4) to grep the on-disk store for
   * plaintext secrets and/or `<secret:…>` markers without having to reason
   * about SQL.
   *
   * This is intentionally a diagnostic dump, not a stable export format —
   * field order and separators are not part of the contract.
   */
  dumpAsText(): string {
    const parts: string[] = [];

    const sessions = this.db.prepare(`SELECT * FROM sessions`).all() as SessionDbRow[];
    for (const s of sessions) {
      parts.push(s.id);
      if (s.slug) parts.push(s.slug);
      if (s.cwd) parts.push(s.cwd);
      if (s.git_branch) parts.push(s.git_branch);
      if (s.cc_version) parts.push(s.cc_version);
      if (s.entrypoint) parts.push(s.entrypoint);
      if (s.first_prompt) parts.push(s.first_prompt);
      if (s.metadata_json) parts.push(s.metadata_json);
    }

    const turns = this.db.prepare(`SELECT * FROM turns`).all() as Array<{
      id: string;
      usage_json: string | null;
    }>;
    for (const t of turns) {
      parts.push(t.id);
      if (t.usage_json) parts.push(t.usage_json);
    }

    const spans = this.db.prepare(`SELECT * FROM action_spans`).all() as SpanDbRow[];
    for (const sp of spans) {
      parts.push(sp.id);
      if (sp.name) parts.push(sp.name);
      if (sp.inputs_json) parts.push(sp.inputs_json);
      if (sp.outputs_json) parts.push(sp.outputs_json);
      if (sp.metadata_json) parts.push(sp.metadata_json);
    }

    const ledger = this.db.prepare(`SELECT * FROM ledger_entries`).all() as LedgerDbRow[];
    for (const l of ledger) {
      parts.push(l.id);
      if (l.source) parts.push(l.source);
      if (l.content_redacted) parts.push(l.content_redacted);
      if (l.source_offset_json) parts.push(l.source_offset_json);
    }

    const bookmarks = this.db.prepare(`SELECT * FROM bookmarks`).all() as BookmarkDbRow[];
    for (const b of bookmarks) {
      parts.push(b.id);
      if (b.label) parts.push(b.label);
      if (b.source) parts.push(b.source);
      if (b.metadata_json) parts.push(b.metadata_json);
    }

    return parts.join('\n');
  }
}
