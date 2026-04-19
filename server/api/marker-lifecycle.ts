/**
 * Marker → Recording lifecycle (L1.3).
 *
 * Pure-ish helpers that convert marker events (from the HTTP endpoint or
 * the importer) into Recording rows. Kept out of the HTTP route so the
 * lifecycle is unit-testable without Express.
 *
 * Rules (from the v0.3 spec):
 *   - /peek_start NAME: if a recording is already open in that session,
 *     close it with status='auto-closed-by-new-start' (endTs = now). Then
 *     create a new 'recording' row.
 *   - /peek_end: close the session's open recording → status='closed'.
 *     /peek_end with no open recording is an orphan (no row created,
 *     `orphan: true` returned so the caller can flag it to the UI).
 *   - Idempotent by requestId: the Recording's id = `rec-<requestId>` so
 *     repeated POSTs from a retried slash command collapse into one row.
 *   - autoCloseStaleRecordings: closes any 'recording' row whose session
 *     has been idle (no new events) for `idleMs`. endTs = lastEventTs,
 *     status = 'auto-closed'.
 */

import { randomUUID } from 'node:crypto';

import type { RecordingRow, Store } from '../pipeline/store';

export type MarkerInput = {
  type: 'start' | 'end';
  name?: string;
  sessionId: string;
  timestamp: string;
  requestId?: string;
};

export type BroadcastFn = (event: string, data: unknown) => void;

export type MarkerOpts = {
  broadcast?: BroadcastFn;
};

export type MarkerResult = {
  recording?: RecordingRow;
  /** True when /peek_end arrived with no open recording for the session. */
  orphan?: boolean;
  /** True when this call was a no-op because requestId was already seen. */
  idempotent?: boolean;
};

function recordingIdFor(requestId: string | undefined): string {
  return requestId ? `rec-${requestId}` : `rec-${randomUUID()}`;
}

export function processMarker(
  store: Store,
  input: MarkerInput,
  opts: MarkerOpts = {}
): MarkerResult {
  const broadcast = opts.broadcast;

  if (input.type === 'start') {
    const id = recordingIdFor(input.requestId);

    // Idempotency: if a recording row with this id already exists (same
    // requestId replayed), return the existing row without side effects.
    const existing = store.getRecording(id);
    if (existing) {
      return { recording: existing, idempotent: true };
    }

    // Auto-close any open recording already held by this session.
    const open = store.listOpenRecordingsBySession(input.sessionId);
    for (const prev of open) {
      store.closeRecording(prev.id, input.timestamp, 'auto-closed-by-new-start');
      if (broadcast) {
        broadcast('recording:ended', {
          id: prev.id,
          name: prev.name,
          sessionId: prev.sessionId,
          endTs: input.timestamp,
          status: 'auto-closed-by-new-start',
        });
      }
    }

    const row: RecordingRow = {
      id,
      name: input.name?.trim() || 'unlabeled',
      sessionId: input.sessionId,
      startTs: input.timestamp,
      status: 'recording',
      createdAt: input.timestamp,
    };
    store.putRecording(row);
    if (broadcast) {
      broadcast('recording:started', {
        id: row.id,
        name: row.name,
        sessionId: row.sessionId,
        startTs: row.startTs,
      });
    }
    return { recording: row };
  }

  // type === 'end'
  const open = store.listOpenRecordingsBySession(input.sessionId);
  if (open.length === 0) {
    // Orphan end — no row created. The caller can still broadcast/log this
    // for visibility but we don't persist orphans as recordings.
    return { orphan: true };
  }
  // Close the most recently started open recording.
  const target = open[open.length - 1];
  store.closeRecording(target.id, input.timestamp, 'closed');
  const closed = store.getRecording(target.id);
  if (broadcast && closed) {
    broadcast('recording:ended', {
      id: closed.id,
      name: closed.name,
      sessionId: closed.sessionId,
      endTs: closed.endTs,
      status: closed.status,
    });
  }
  return { recording: closed ?? undefined };
}

export type AutoCloseOpts = {
  now: string;
  lastEventTsBySession: Record<string, string | undefined>;
  idleMs: number;
  broadcast?: BroadcastFn;
};

export function autoCloseStaleRecordings(store: Store, opts: AutoCloseOpts): number {
  const nowMs = Date.parse(opts.now);
  let closed = 0;
  for (const r of store.listRecordings()) {
    if (r.status !== 'recording') continue;
    const last = opts.lastEventTsBySession[r.sessionId] ?? r.startTs;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) continue;
    if (nowMs - lastMs < opts.idleMs) continue;
    store.closeRecording(r.id, last, 'auto-closed');
    closed++;
    if (opts.broadcast) {
      opts.broadcast('recording:ended', {
        id: r.id,
        name: r.name,
        sessionId: r.sessionId,
        endTs: last,
        status: 'auto-closed',
      });
    }
  }
  return closed;
}
