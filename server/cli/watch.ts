/**
 * `peek watch` — file-system daemon (v0.2.1 L1.1).
 *
 * Watches `<claudeDir>/**\/*.jsonl` via chokidar. On `add` (new file) or
 * `change` (append / rewrite) the watcher re-imports the affected JSONL
 * through `importPath`, which upserts the resulting session/turns/spans/
 * ledger rows into the Store (all writes are `INSERT OR REPLACE`).
 *
 * Two SSE signals are emitted:
 *   - `session:new` — on first-time import of a session id we haven't seen
 *   - `span:new`    — on subsequent re-imports where the span count grew
 *
 * Design notes
 * ------------
 * • The v0.2.1 plan mentions a `sourceOffset` column for incremental import.
 *   That column lives on `ledger_entries` (per-block byte range), not as a
 *   per-file watermark, so we currently re-parse the entire JSONL on each
 *   change. That's O(file-size) but upsert-safe — duplicate rows collapse
 *   via INSERT OR REPLACE — and good enough for typical session sizes
 *   (< few MB). A byte-watermark optimisation is tracked as a future
 *   refinement; correctness is in no way affected.
 *
 * • We debounce per-file change events at 100ms — chokidar's default raw
 *   change stream can fire several times per `appendFileSync` call on
 *   macOS (once per fs stat bump). Without the debounce we'd re-import
 *   the same file 3-5× per append.
 *
 * • `broadcast()` is a no-op when no SSE subscribers are connected, so the
 *   watcher is safe to run standalone.
 */

import { watch, type FSWatcher } from 'chokidar';
import { mkdirSync, statSync } from 'node:fs';

import { importPath } from '../pipeline/import';
import { Store } from '../pipeline/store';
import { broadcast } from '../api/sse';

export type StartWatchOpts = {
  dataDir: string;
  claudeDir: string;
};

export type ImportStatus = {
  /** Files successfully imported since this watcher started. */
  importedCount: number;
  /** Files currently sitting in the queue, waiting for the worker. */
  queueLength: number;
  /** True iff the worker is actively processing a file right now. */
  inProgress: boolean;
  /** Path of the file currently being imported, when `inProgress`. */
  currentFile: string | null;
};

export type Watcher = {
  stop: () => Promise<void>;
  /**
   * Live view of the import queue. The HTTP layer exposes this via
   * `/api/import-status` so the UI can render a "importing N of M sessions"
   * progress indicator during the bulk initial scan on first launch.
   */
  status: () => ImportStatus;
};

type FileState = {
  /** Last size seen, for quick skip when a `change` event fires with no growth. */
  lastSize: number;
  /** Pending debounce timer so burst appends collapse into one import. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** True once we've emitted `session:new` for at least one session from this file. */
  seededSessions: Set<string>;
  /** Span count per session id after last successful import. */
  lastSpanCounts: Map<string, number>;
};

const DEBOUNCE_MS = 100;

/**
 * Look up the set of known session ids + per-session span counts from the
 * Store so a freshly-started watcher doesn't re-emit `session:new` for every
 * existing file on disk.
 */
function snapshotStore(dataDir: string): {
  sessionIds: Set<string>;
  spanCounts: Map<string, number>;
} {
  const store = new Store(dataDir);
  try {
    const anyStore = store as unknown as {
      db: {
        prepare: (sql: string) => {
          all: () => Array<{ id?: string; session_id?: string; c?: number }>;
        };
      };
    };
    const sessionRows = anyStore.db.prepare('SELECT id FROM sessions').all();
    const sessionIds = new Set<string>(sessionRows.map((r) => String(r.id)));
    const spanRows = anyStore.db
      .prepare('SELECT session_id, COUNT(*) AS c FROM action_spans GROUP BY session_id')
      .all();
    const spanCounts = new Map<string, number>();
    for (const r of spanRows) {
      spanCounts.set(String(r.session_id), Number(r.c ?? 0));
    }
    return { sessionIds, spanCounts };
  } finally {
    store.close();
  }
}

export async function startWatch(opts: StartWatchOpts): Promise<Watcher> {
  const { dataDir, claudeDir } = opts;

  // Prime state from existing DB so pre-existing sessions don't re-broadcast.
  const initial = snapshotStore(dataDir);
  const knownSessions = initial.sessionIds;
  const fileStates = new Map<string, FileState>();

  // chokidar v5 with `cwd + glob` does not reliably report files created
  // under subdirectories that are themselves created after the watcher is
  // ready. Watching the directory root (absolute path) + filtering on
  // `.jsonl` in the event handler is the documented work-around and matches
  // the behaviour we verified empirically against chokidar 5.0.0 on macOS.
  //
  // Ensure the watched root exists. Fresh `peek install` + `peek` flows on
  // a new machine will hit `peek` before any Claude Code session has ever
  // run, so `~/.claude/projects` may not exist yet. chokidar silently
  // watches nothing in that case; we create the dir up-front so the
  // first JSONL that lands there fires `add`. (v0.2.1 L5-followup.)
  try {
    mkdirSync(claudeDir, { recursive: true });
  } catch {
    // If we can't create it (permission denied on a read-only FS, say),
    // fall through — chokidar will silently watch nothing, which is the
    // least-bad outcome. The daemon still serves HTTP successfully.
  }

  // `ignored`: skip dot-prefixed path segments relative to the watched root
  // only. Matching the root itself (e.g. `~/.claude/projects`) against a
  // naïve `/(^|\/)\.[^/]/` regex would reject everything — the leading
  // `.claude` component in the ancestor path would trip the pattern for
  // every descendant path. We strip the `claudeDir` prefix first, then
  // check whether any SEGMENT of the relative remainder starts with `.`.
  // Fixes a silent no-op daemon on default `~/.claude/projects` setups
  // (v0.2.1 L5-followup).
  const rootPrefix = claudeDir.endsWith('/') ? claudeDir : claudeDir + '/';
  const watcher: FSWatcher = watch(claudeDir, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: false,
    ignored: (p: string) => {
      if (p === claudeDir) return false;
      const rel = p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;
      return rel.split('/').some((seg) => seg.startsWith('.'));
    },
  });

  const isJsonl = (p: string): boolean => p.endsWith('.jsonl');

  const importFile = async (absPath: string): Promise<void> => {
    const state = fileStates.get(absPath) ?? {
      lastSize: 0,
      debounceTimer: null,
      seededSessions: new Set<string>(),
      lastSpanCounts: new Map<string, number>(),
    };
    fileStates.set(absPath, state);

    try {
      const result = await importPath(absPath, { dataDir });
      const summaries = (result as { sessions?: Array<{ id: string }> }).sessions ?? [];

      // Refresh span counts post-import.
      const { spanCounts: currentCounts } = snapshotStore(dataDir);

      for (const s of summaries) {
        const isNewSession = !knownSessions.has(s.id) && !state.seededSessions.has(s.id);
        if (isNewSession) {
          knownSessions.add(s.id);
          state.seededSessions.add(s.id);
          broadcast('session:new', { sessionId: s.id, file: absPath });
        } else {
          const before = state.lastSpanCounts.get(s.id) ?? initial.spanCounts.get(s.id) ?? 0;
          const after = currentCounts.get(s.id) ?? 0;
          if (after > before) {
            broadcast('span:new', { sessionId: s.id, spanDelta: after - before });
          }
        }
        state.lastSpanCounts.set(s.id, currentCounts.get(s.id) ?? 0);
      }

      try {
        state.lastSize = statSync(absPath).size;
      } catch {
        // file vanished between import and stat — ignore.
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[peek watch] import failed for ${absPath}: ${(err as Error).message}`);
    }
  };

  // ── Import queue ────────────────────────────────────────────────────────
  // Pre-fix, each `add` event spawned its own 100ms debounce timer, and
  // after the debounce fired we called `void importFile(absPath)` — 93
  // concurrent sync-heavy imports started at once, saturating the event
  // loop for minutes while the HTTP server's `listen()` had already
  // resolved. healthz requests timed out against a process at 100% CPU.
  //
  // Fix: a single drain queue. `add`/`change` push the path onto the
  // queue; the worker imports one file at a time and yields to the event
  // loop via `await new Promise(r => setImmediate(r))` between files so
  // HTTP handlers (and timers) interleave freely. We also dedupe — if
  // the same file is enqueued twice before its turn, we only import once.
  const queue: string[] = [];
  const queued = new Set<string>();
  let inProgress = false;
  let currentFile: string | null = null;
  let importedCount = 0;
  let draining = false;
  let drainPromise: Promise<void> | null = null;
  let stopped = false;

  const drainQueue = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        const next = queue.shift()!;
        queued.delete(next);
        inProgress = true;
        currentFile = next;
        try {
          await importFile(next);
          importedCount += 1;
        } catch {
          // importFile already logs; never let one bad file break the queue.
        }
        inProgress = false;
        currentFile = null;
        // Yield to the libuv poll phase so pending I/O + timers run before
        // we pick up the next file. Without this, a tight `await import`
        // loop keeps the microtask queue full and starves HTTP responses.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      draining = false;
      drainPromise = null;
    }
  };

  const enqueue = (absPath: string): void => {
    if (stopped) return;
    if (queued.has(absPath)) return;
    queued.add(absPath);
    queue.push(absPath);
    if (!drainPromise) drainPromise = drainQueue();
  };

  const scheduleImport = (absPath: string): void => {
    const state = fileStates.get(absPath) ?? {
      lastSize: 0,
      debounceTimer: null,
      seededSessions: new Set<string>(),
      lastSpanCounts: new Map<string, number>(),
    };
    fileStates.set(absPath, state);
    // Keep the 100ms debounce so `change` bursts (macOS fires 3-5× per
    // appendFileSync) collapse into one enqueue. The debounce only gates
    // queue entry — actual CPU work is paced by the single-worker drain.
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      enqueue(absPath);
    }, DEBOUNCE_MS);
  };

  // chokidar emits 'add' (first time we see the file) and 'change' (mtime/
  // size bump). Paths are absolute since we watch by absolute dir (see note
  // on the watch() call above).
  watcher.on('add', (absPath: string) => {
    if (!isJsonl(absPath)) return;
    scheduleImport(absPath);
  });
  watcher.on('change', (absPath: string) => {
    if (!isJsonl(absPath)) return;
    scheduleImport(absPath);
  });

  // Wait until the initial scan completes so callers can rely on `ready`
  // semantics — useful in tests where files are written BEFORE startWatch()
  // returns (the `ignoreInitial: false` pass will pick them up pre-ready).
  await new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  return {
    status(): ImportStatus {
      return {
        importedCount,
        queueLength: queue.length,
        inProgress,
        currentFile,
      };
    },
    async stop() {
      stopped = true;
      // Clear pending debounce timers so nothing gets enqueued after stop.
      for (const state of fileStates.values()) {
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
      }
      fileStates.clear();
      // Drop anything still queued; let the in-flight import settle.
      queue.length = 0;
      queued.clear();
      if (drainPromise) {
        try {
          await drainPromise;
        } catch {
          /* already logged */
        }
      }
      await watcher.close();
    },
  };
}
