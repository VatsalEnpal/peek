/**
 * L2.3 — Live-sessions list wiring for the SessionsPage.
 *
 * Owns the "which sessions are live?" state. The component subscribes to the
 * SSE stream and stamps a sessionId → lastActivity timestamp whenever:
 *
 *   session:new → refetch the session list (a brand-new session appeared
 *                 server-side; we need the summary row) and stamp the id.
 *   span:new    → refresh the stamp so active sessions stay "live" while
 *                 their tail keeps updating.
 *
 * Staleness: a session is live while `Date.now() - lastActivity < 5 minutes`.
 * Past that threshold the LIVE badge disappears and the hint bar can return
 * (see L2.6 gating in SessionsPage).
 *
 * `hasAnyLive()` is the predicate SessionsPage uses to gate the "watching
 * ~/.claude/projects/" hint — the hint reads stale when no session is live.
 *
 * The state is stored in React state (not zustand) because it's view-local
 * and resets when the page unmounts — no other page needs to read it.
 */

import { useCallback, useEffect, useState } from 'react';

import { subscribe } from './sse';
import { useSessionStore } from '../stores/session';

export const STALE_AFTER_MS = 5 * 60 * 1000;

export type LiveSessionsApi = {
  /** True when the session was marked live within the staleness window. */
  isLive: (sessionId: string) => boolean;
  /** True when at least one tracked session is still within the window. */
  hasAnyLive: () => boolean;
};

type ActivityMap = Record<string, number>;

/**
 * Subscribe a component to live-session updates. Returns the live/stale
 * predicate API. Triggers a React re-render whenever the map changes so
 * consumers see updated LIVE badges without manual invalidation.
 */
export function useLiveSessionsList(): LiveSessionsApi {
  const [activity, setActivity] = useState<ActivityMap>({});

  useEffect(() => {
    const unsub = subscribe((event, data) => {
      const payload = (data ?? {}) as { sessionId?: unknown };
      const sessionId =
        typeof payload.sessionId === 'string' && payload.sessionId.length > 0
          ? payload.sessionId
          : null;
      if (!sessionId) return;

      if (event === 'session:new') {
        void useSessionStore.getState().fetchSessions();
      }
      if (event === 'session:new' || event === 'span:new') {
        const now = Date.now();
        setActivity((prev) => ({ ...prev, [sessionId]: now }));
      }
    });
    return unsub;
  }, []);

  const isLive = useCallback(
    (sessionId: string): boolean => {
      const last = activity[sessionId];
      if (typeof last !== 'number') return false;
      return Date.now() - last < STALE_AFTER_MS;
    },
    [activity]
  );

  const hasAnyLive = useCallback((): boolean => {
    const now = Date.now();
    for (const ts of Object.values(activity)) {
      if (now - ts < STALE_AFTER_MS) return true;
    }
    return false;
  }, [activity]);

  return { isLive, hasAnyLive };
}
