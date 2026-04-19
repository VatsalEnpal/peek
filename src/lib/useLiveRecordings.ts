/**
 * L3.3 — Live SSE wiring for the RecordingsPage.
 *
 * Subscribes to the shared SSE stream and mutates the RecordingsStore so
 * the table updates without a page refresh:
 *
 *   recording:started  → inject row, pinned as live
 *   recording:ended    → flip status + stamp endTs on the matching row
 *   span:new           → if payload has recordingId, bump that row's counters
 *
 * The hook is side-effect only; returns void. Components that need read
 * access should read `useRecordingsStore` directly.
 */

import { useEffect } from 'react';

import { subscribe } from './sse';
import { useRecordingsStore, type RecordingStatus } from '../stores/recordings';

type StartedPayload = {
  id?: unknown;
  name?: unknown;
  sessionId?: unknown;
  startTs?: unknown;
};
type EndedPayload = {
  id?: unknown;
  endTs?: unknown;
  status?: unknown;
};
type SpanPayload = {
  recordingId?: unknown;
  spanDelta?: unknown;
};

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function useLiveRecordings(): void {
  const applyStarted = useRecordingsStore((s) => s.applyStarted);
  const applyEnded = useRecordingsStore((s) => s.applyEnded);
  const incrementCounters = useRecordingsStore((s) => s.incrementCounters);

  useEffect(() => {
    const unsub = subscribe((event, data) => {
      if (event === 'recording:started') {
        const p = (data ?? {}) as StartedPayload;
        const id = asString(p.id);
        const name = asString(p.name);
        const sessionId = asString(p.sessionId);
        const startTs = asString(p.startTs);
        if (id && name && sessionId && startTs) {
          applyStarted({ id, name, sessionId, startTs });
        }
      } else if (event === 'recording:ended') {
        const p = (data ?? {}) as EndedPayload;
        const id = asString(p.id);
        if (id) {
          const endTs = asString(p.endTs);
          const status = asString(p.status) as RecordingStatus | undefined;
          applyEnded({
            id,
            ...(endTs !== undefined ? { endTs } : {}),
            ...(status !== undefined ? { status } : {}),
          });
        }
      } else if (event === 'span:new') {
        const p = (data ?? {}) as SpanPayload;
        const recordingId = asString(p.recordingId);
        const delta =
          typeof p.spanDelta === 'number' && Number.isFinite(p.spanDelta) ? p.spanDelta : 1;
        if (recordingId) {
          // We don't know whether the new span is a tool call or an API call
          // from this payload — the exact split is reconciled at the next
          // fetchRecordings() call. Optimistically bump toolCount as it's the
          // most common case; the server wins on refetch.
          incrementCounters(recordingId, { tools: delta });
        }
      }
    });
    return unsub;
  }, [applyStarted, applyEnded, incrementCounters]);
}
