// @vitest-environment happy-dom
/**
 * L2.3 — `useLiveSessionsList()` hook + live-session staleness logic.
 *
 * The hook owns the live-status map that the Sessions page reads. Contract:
 *   • On `session:new`: refetch the session list and stamp that sessionId
 *     with `lastActivity = now`.
 *   • On `span:new`: refresh the activity stamp for that sessionId (if
 *     present — we never stamp an unknown id; the session:new event fires
 *     first per the L1 contract).
 *   • `isLive(sessionId)` returns true iff `now - lastActivity < staleMs`.
 *   • Default staleness threshold = 5 minutes (300_000 ms).
 *
 * The SSE `subscribe()` module is mocked so events are driven
 * deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

let capturedListener: ((event: string, data: unknown) => void) | null = null;
let unsubscribeCalls = 0;

vi.mock('../../src/lib/sse', () => ({
  subscribe: vi.fn((cb: (event: string, data: unknown) => void) => {
    capturedListener = cb;
    return () => {
      unsubscribeCalls += 1;
      capturedListener = null;
    };
  }),
}));

import {
  useLiveSessionsList,
  STALE_AFTER_MS,
  type LiveSessionsApi,
} from '../../src/lib/useLiveSessionsList';
import { useSessionStore } from '../../src/stores/session';

function Harness({ onApi }: { onApi: (api: LiveSessionsApi) => void }): null {
  const api = useLiveSessionsList();
  onApi(api);
  return null;
}

beforeEach(() => {
  capturedListener = null;
  unsubscribeCalls = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));
  useSessionStore.setState({
    fetchSessions: vi.fn(async (): Promise<void> => {}),
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useLiveSessionsList — L2.3', () => {
  it('exposes STALE_AFTER_MS = 5 minutes', () => {
    expect(STALE_AFTER_MS).toBe(5 * 60 * 1000);
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    let api: LiveSessionsApi | null = null;
    const { unmount } = render(<Harness onApi={(a): void => { api = a; }} />);
    expect(api).not.toBeNull();
    expect(capturedListener).not.toBeNull();
    unmount();
    expect(unsubscribeCalls).toBe(1);
  });

  it('session:new triggers fetchSessions and marks the session live', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);
    const fetchSessions = useSessionStore.getState().fetchSessions as ReturnType<typeof vi.fn>;

    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-A' });
    });

    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(api!.isLive('sess-A')).toBe(true);
  });

  it('sessions without any activity are not live', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);
    expect(api!.isLive('never-seen')).toBe(false);
  });

  it('session becomes stale after 5 minutes without activity', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);

    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-A' });
    });
    expect(api!.isLive('sess-A')).toBe(true);

    // 4:59 later — still live.
    vi.setSystemTime(new Date('2026-04-19T12:04:59Z'));
    expect(api!.isLive('sess-A')).toBe(true);

    // 5:01 later — stale.
    vi.setSystemTime(new Date('2026-04-19T12:05:01Z'));
    expect(api!.isLive('sess-A')).toBe(false);
  });

  it('span:new refreshes the live stamp', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);

    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-A' });
    });
    // 4:30 later — still live, about to go stale in 30s.
    vi.setSystemTime(new Date('2026-04-19T12:04:30Z'));
    expect(api!.isLive('sess-A')).toBe(true);

    // A span:new arrives → stamp refreshes.
    act(() => {
      capturedListener?.('span:new', { sessionId: 'sess-A' });
    });

    // 4:59 after the refresh (= 9:29 after session:new) — still live.
    vi.setSystemTime(new Date('2026-04-19T12:09:29Z'));
    expect(api!.isLive('sess-A')).toBe(true);

    // 5:01 after the refresh → stale.
    vi.setSystemTime(new Date('2026-04-19T12:09:31Z'));
    expect(api!.isLive('sess-A')).toBe(false);
  });

  it('hasAnyLive returns true when at least one session is live', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);

    expect(api!.hasAnyLive()).toBe(false);
    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-A' });
    });
    expect(api!.hasAnyLive()).toBe(true);

    // Wait past stale threshold.
    vi.setSystemTime(new Date('2026-04-19T12:05:01Z'));
    expect(api!.hasAnyLive()).toBe(false);
  });

  it('hasAnyLive is true if any session is live, even when others are stale', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);

    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-A' });
    });
    vi.setSystemTime(new Date('2026-04-19T12:04:00Z'));
    act(() => {
      capturedListener?.('session:new', { sessionId: 'sess-B' });
    });

    // Wait until A is stale but B still live.
    vi.setSystemTime(new Date('2026-04-19T12:05:30Z'));
    expect(api!.isLive('sess-A')).toBe(false);
    expect(api!.isLive('sess-B')).toBe(true);
    expect(api!.hasAnyLive()).toBe(true);
  });

  it('ignores malformed events without sessionId', () => {
    let api: LiveSessionsApi | null = null;
    render(<Harness onApi={(a): void => { api = a; }} />);

    capturedListener?.('span:new', {});
    capturedListener?.('session:new', null);
    // Nothing threw, nothing became live.
    expect(api!.hasAnyLive()).toBe(false);
  });
});
