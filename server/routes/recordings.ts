/**
 * Recordings routes (v0.3 L2).
 *
 *   GET  /api/recordings
 *     → [{ id, name, sessionId, startTs, endTs, status, durationMs,
 *         toolCount, apiCount, totalTokens }]
 *     Open recordings pinned to the top, then by startTs desc.
 *
 *   GET  /api/recordings/:id
 *     → single recording with the same computed counts as the list row.
 *     404 if the id doesn't resolve.
 *
 *   GET  /api/recordings/:id/events[?includeLifecycle=1]
 *     → span + ledger events bounded by session_id + [start_ts..end_ts].
 *     Lifecycle noise (bridge_status, permission-mode, etc.) is filtered by
 *     default so the timeline reads like the "Ctrl+O" view; the query param
 *     flips it back on for power users.
 */

import { Router, type Request, type Response } from 'express';

import type { RecordingRow, Store, StoreEvent } from '../pipeline/store';

const router = Router();

/**
 * Claude Code lifecycle event types filtered out of the default recording
 * detail view. Kept in one place so the UI "Show internal events" toggle
 * later can flip a single flag. Listed in the v0.3 spec.
 */
const LIFECYCLE_TYPES = new Set<string>([
  'bridge_status',
  'command_permissions',
  'mcp_instructions_delta',
  'deferred_tools_delta',
  'stop_hook_summary',
  'auto_mode',
  'turn_duration',
  'file-history-snapshot',
  'permission-mode',
  'away_summary',
  'last-prompt',
  'queue-operation',
  'task_reminder',
]);

function isApiCallType(type: string): boolean {
  // Treat any type starting with 'api' as an API call (api_call, api_request,
  // api_response). Tolerant to variations in the importer naming.
  return /^api[_-]/i.test(type) || type === 'api_call';
}

function isToolUseType(type: string): boolean {
  return type === 'tool_use' || type === 'tool_call';
}

function eventsInWindow(store: Store, recording: RecordingRow): StoreEvent[] {
  return store.listEvents(recording.sessionId, {
    start: recording.startTs,
    ...(recording.endTs !== undefined ? { end: recording.endTs } : {}),
  });
}

type RecordingSummary = {
  id: string;
  name: string;
  sessionId: string;
  startTs: string;
  endTs: string | null;
  status: RecordingRow['status'];
  createdAt: string;
  durationMs: number | null;
  toolCount: number;
  apiCount: number;
  totalTokens: number;
};

function summarise(store: Store, r: RecordingRow): RecordingSummary {
  const events = eventsInWindow(store, r);
  let toolCount = 0;
  let apiCount = 0;
  let totalTokens = 0;
  for (const e of events) {
    if (e.kind === 'span') {
      if (isToolUseType(e.type)) toolCount++;
      else if (isApiCallType(e.type)) apiCount++;
      if (typeof e.tokensConsumed === 'number') totalTokens += e.tokensConsumed;
    } else {
      if (typeof e.tokens === 'number') totalTokens += e.tokens;
    }
  }
  let durationMs: number | null = null;
  if (r.endTs) {
    const a = Date.parse(r.startTs);
    const b = Date.parse(r.endTs);
    if (Number.isFinite(a) && Number.isFinite(b)) durationMs = b - a;
  }
  return {
    id: r.id,
    name: r.name,
    sessionId: r.sessionId,
    startTs: r.startTs,
    endTs: r.endTs ?? null,
    status: r.status,
    createdAt: r.createdAt,
    durationMs,
    toolCount,
    apiCount,
    totalTokens,
  };
}

/** Stable ordering: open recordings first (status='recording'), then startTs desc. */
function recordingOrder(a: RecordingRow, b: RecordingRow): number {
  const aOpen = a.status === 'recording' ? 1 : 0;
  const bOpen = b.status === 'recording' ? 1 : 0;
  if (aOpen !== bOpen) return bOpen - aOpen;
  if (a.startTs !== b.startTs) return a.startTs < b.startTs ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

router.get('/', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const rows = store.listRecordings().slice().sort(recordingOrder);
  res.json(rows.map((r) => summarise(store, r)));
});

router.get('/:id', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id ?? '');
  const row = store.getRecording(id);
  if (!row) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  res.json(summarise(store, row));
});

router.get('/:id/events', (req: Request, res: Response) => {
  const store = req.app.locals.store as Store;
  const id = String(req.params.id ?? '');
  const row = store.getRecording(id);
  if (!row) {
    res.status(404).json({ error: 'recording not found' });
    return;
  }
  const includeLifecycle =
    req.query.includeLifecycle === '1' || req.query.includeLifecycle === 'true';
  const events = eventsInWindow(store, row);
  const filtered = includeLifecycle
    ? events
    : events.filter((e) => (e.kind === 'span' ? !LIFECYCLE_TYPES.has(e.type) : true));
  res.json(filtered);
});

export default router;
