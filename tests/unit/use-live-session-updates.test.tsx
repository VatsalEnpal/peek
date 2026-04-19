// @vitest-environment happy-dom
/**
 * L2.2 — `useLiveSessionUpdates(sessionId)` hook.
 *
 * This hook subscribes the SessionDetail view to the SSE stream and wires:
 *   • `span:new` for the current sessionId → refetch timeline events.
 *   • `marker:opened` / `marker:closed` for the current sessionId → invalidate
 *     + refetch the bookmarks cache for that session so the sidebar/list
 *     reflects the new marker.
 *   • unmount → unsubscribe (no leaks).
 *
 * We test the hook in isolation rather than the full SessionDetailPage because
 * the page carries a lot of URL/router/keyboard state the live-wiring doesn't
 * need. The hook is a small, well-boundaried unit.
 *
 * The SSE module is mocked to capture the subscribe callback so tests can
 * drive events synchronously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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

import { useLiveSessionUpdates } from '../../src/lib/useLiveSessionUpdates';
import { useSessionStore } from '../../src/stores/session';
import { useBookmarksStore } from '../../src/stores/bookmarks';

function Harness({ sessionId }: { sessionId: string | null }): null {
  useLiveSessionUpdates(sessionId);
  return null;
}

beforeEach(() => {
  capturedListener = null;
  unsubscribeCalls = 0;

  useSessionStore.setState({
    refetchEvents: vi.fn(async (): Promise<void> => {}),
    selectedSessionId: 'sess-A',
  });
  useBookmarksStore.setState({
    bySession: { 'sess-A': [], 'sess-B': [] },
    loading: false,
    error: null,
    invalidate: vi.fn(),
    fetchForSession: vi.fn(async (): Promise<void> => {}),
  });
});

afterEach(() => {
  cleanup();
});

describe('useLiveSessionUpdates', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<Harness sessionId="sess-A" />);
    expect(capturedListener).not.toBeNull();
    expect(unsubscribeCalls).toBe(0);
    unmount();
    expect(unsubscribeCalls).toBe(1);
  });

  it('refetches events when span:new arrives for the current session', async () => {
    render(<Harness sessionId="sess-A" />);
    const refetch = useSessionStore.getState().refetchEvents as ReturnType<typeof vi.fn>;
    capturedListener?.('span:new', { sessionId: 'sess-A', spanDelta: 1 });
    // Allow the hook's async handler to flush.
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ignores span:new for a different session', () => {
    render(<Harness sessionId="sess-A" />);
    const refetch = useSessionStore.getState().refetchEvents as ReturnType<typeof vi.fn>;
    capturedListener?.('span:new', { sessionId: 'sess-OTHER', spanDelta: 1 });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('invalidates bookmarks cache and refetches on marker:opened for current session', async () => {
    render(<Harness sessionId="sess-A" />);
    const invalidate = useBookmarksStore.getState().invalidate as ReturnType<typeof vi.fn>;
    const fetchForSession = useBookmarksStore.getState().fetchForSession as ReturnType<
      typeof vi.fn
    >;
    capturedListener?.('marker:opened', { id: 'm1', sessionId: 'sess-A', label: 'test' });
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledWith('sess-A');
    expect(fetchForSession).toHaveBeenCalledWith('sess-A');
  });

  it('also refreshes bookmarks on marker:closed for current session', async () => {
    render(<Harness sessionId="sess-A" />);
    const invalidate = useBookmarksStore.getState().invalidate as ReturnType<typeof vi.fn>;
    capturedListener?.('marker:closed', { id: 'm1', sessionId: 'sess-A' });
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledWith('sess-A');
  });

  it('ignores marker events for a different session', () => {
    render(<Harness sessionId="sess-A" />);
    const invalidate = useBookmarksStore.getState().invalidate as ReturnType<typeof vi.fn>;
    capturedListener?.('marker:opened', { id: 'm1', sessionId: 'sess-OTHER' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('is inert when sessionId is null', () => {
    render(<Harness sessionId={null} />);
    // Hook should still subscribe (so it's resilient if sessionId arrives
    // later), but dispatches must be no-ops.
    expect(capturedListener).not.toBeNull();
    const refetch = useSessionStore.getState().refetchEvents as ReturnType<typeof vi.fn>;
    capturedListener?.('span:new', { sessionId: 'anything' });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('re-targets when sessionId changes (new session A → B routes events to B)', async () => {
    const { rerender } = render(<Harness sessionId="sess-A" />);
    const refetch = useSessionStore.getState().refetchEvents as ReturnType<typeof vi.fn>;

    // First, fire for A — should route.
    capturedListener?.('span:new', { sessionId: 'sess-A' });
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(1);

    // Re-render pointing at B, then fire for A — should NOT route, fire for B
    // SHOULD route.
    rerender(<Harness sessionId="sess-B" />);
    capturedListener?.('span:new', { sessionId: 'sess-A' });
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(1);

    capturedListener?.('span:new', { sessionId: 'sess-B' });
    await Promise.resolve();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
