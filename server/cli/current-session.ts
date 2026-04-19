/**
 * Shared module-level state for "which Claude Code session is currently
 * being appended to" (v0.2.1 L11a).
 *
 * The watcher updates this every time a JSONL file is imported — the
 * most-recently-appended JSONL basename (minus `.jsonl`) is treated as the
 * live session. The marker API reads it so `POST /api/markers` with no
 * explicit `sessionId` attaches bookmarks to the real CC session instead of
 * the synthetic sentinel string `"live"`.
 *
 * Module-level state is the right choice here because a peek daemon is a
 * singleton process. Tests reset it via `resetCurrentSessionId()` between
 * cases.
 */

let currentSessionId: string | null = null;

/** Update the most-recently-active session id. Called by the watcher. */
export function setCurrentSessionId(id: string): void {
  if (typeof id === 'string' && id.length > 0) {
    currentSessionId = id;
  }
}

/** Read the most-recently-active session id, or null if none detected yet. */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/** Reset between tests. Not part of the production API surface. */
export function resetCurrentSessionId(): void {
  currentSessionId = null;
}
