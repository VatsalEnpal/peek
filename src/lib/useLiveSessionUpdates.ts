/**
 * L2.2 — Live timeline wiring for the SessionDetail view.
 *
 * Subscribes to the SSE stream while the detail page is mounted and maps the
 * four live-mode events onto existing store actions:
 *
 *   span:new (same sessionId)       → refetch the timeline events, so new
 *                                      rows appear in chronological order.
 *   marker:opened / marker:closed   → invalidate + refetch the bookmarks
 *                                      cache for the session so marker bars
 *                                      surface without a manual reload.
 *   session:new                     → ignored here; the SessionsPage listens.
 *
 * A `sessionIdRef` keeps the latest targeted session-id visible to the
 * subscriber callback without tearing down / re-subscribing every time the
 * caller re-renders — that would double up the EventSource on every navigation
 * and thrash the reconnect schedule.
 *
 * The callback paths are tiny; per-event work is synchronous store mutation
 * plus a fetch kicked off via `void`.
 */

import { useEffect, useRef } from 'react';

import { subscribe } from './sse';
import { useSessionStore } from '../stores/session';
import { useBookmarksStore } from '../stores/bookmarks';

/**
 * Wire the SSE stream into the session-detail view.
 *
 * @param sessionId  The session currently being viewed. `null` means "no
 *                   session yet" and all incoming events are ignored.
 */
export function useLiveSessionUpdates(sessionId: string | null): void {
  // Latest `sessionId` captured in a ref so the stable subscribe() callback
  // below always reads the current target without re-subscribing.
  const sessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const unsub = subscribe((event, data) => {
      const current = sessionIdRef.current;
      if (current === null) return;

      const payload = (data ?? {}) as { sessionId?: string };
      if (payload.sessionId !== current) return;

      switch (event) {
        case 'span:new': {
          void useSessionStore.getState().refetchEvents();
          return;
        }
        case 'marker:opened':
        case 'marker:closed': {
          const bm = useBookmarksStore.getState();
          bm.invalidate(current);
          void bm.fetchForSession(current);
          return;
        }
        default:
          return;
      }
    });
    return unsub;
  }, []);
}
