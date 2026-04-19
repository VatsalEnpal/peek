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
import { statSync } from 'node:fs';

import { importPath } from '../pipeline/import';
import { Store } from '../pipeline/store';
import { broadcast } from '../api/sse';

export type StartWatchOpts = {
  dataDir: string;
  claudeDir: string;
};

export type Watcher = {
  stop: () => Promise<void>;
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
  // `ignored`: skip dot-prefixed path segments relative to the watched root
  // only. Matching the root itself (e.g. `~/.claude/projects`) against a
  // naïve `/(^|\/)\.[^/]/` regex would reject everything — the leading
  // `.claude` component in the ancestor path would trip the pattern for
  // every descendant path. We strip the `claudeDir` prefix first, then
  // check whether any SEGMENT of the relative remainder starts with `.`.
  // Fixes a silent no-op daemon on default `~/.claude/projects` setups.
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

  const scheduleImport = (absPath: string): void => {
    const state = fileStates.get(absPath) ?? {
      lastSize: 0,
      debounceTimer: null,
      seededSessions: new Set<string>(),
      lastSpanCounts: new Map<string, number>(),
    };
    fileStates.set(absPath, state);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void importFile(absPath);
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
    async stop() {
      for (const state of fileStates.values()) {
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
      }
      fileStates.clear();
      await watcher.close();
    },
  };
}
