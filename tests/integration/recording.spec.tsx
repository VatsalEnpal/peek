// @vitest-environment happy-dom
/**
 * Recording-mode UI tests — Groups 11+12+13 bundle.
 *
 * Scope:
 *  - Recording store start/stop.
 *  - RecordButton POSTs /api/bookmarks and flips store state.
 *  - TimelineRow right-click → focus-from-here updates selection.focusRange.
 *  - FocusBar renders given a non-empty focusRange with event + token counts.
 *  - SessionPicker expands per-session bookmarks.
 *  - Cmd+Shift+R hotkey toggles recording.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from '../../src/App';
import { RecordButton } from '../../src/components/RecordButton';
import { FocusBar } from '../../src/components/FocusBar';
import { useSessionStore } from '../../src/stores/session';
import { useSelectionStore } from '../../src/stores/selection';
import { useRecordingStore } from '../../src/stores/recording';
import { useBookmarksStore } from '../../src/stores/bookmarks';

const SESSIONS = [
  {
    id: 'sess-rec-1',
    label: 'recording target',
    firstPrompt: 'implement recording mode',
    turnCount: 2,
    totalTokens: 700,
    timeAgo: '1m ago',
    startTs: '2026-04-18T09:00:00Z',
    endTs: '2026-04-18T09:03:00Z',
  },
];

const EVENTS = [
  {
    kind: 'span',
    id: 'span-u-1',
    sessionId: 'sess-rec-1',
    type: 'user',
    name: 'first prompt',
    startTs: '2026-04-18T09:00:05Z',
    durationMs: 8,
  },
  {
    kind: 'span',
    id: 'span-t-1',
    sessionId: 'sess-rec-1',
    type: 'tool',
    name: 'Read something',
    startTs: '2026-04-18T09:01:00Z',
    durationMs: 22,
  },
  {
    kind: 'span',
    id: 'span-u-2',
    sessionId: 'sess-rec-1',
    type: 'user',
    name: 'second prompt',
    startTs: '2026-04-18T09:02:00Z',
    durationMs: 12,
  },
  {
    kind: 'ledger',
    id: 'led-1',
    sessionId: 'sess-rec-1',
    introducedBySpanId: 'span-t-1',
    source: 'tool',
    tokens: 110,
    contentRedacted: 'ok',
    ts: '2026-04-18T09:01:00Z',
  },
  {
    kind: 'ledger',
    id: 'led-2',
    sessionId: 'sess-rec-1',
    introducedBySpanId: 'span-u-2',
    source: 'user',
    tokens: 55,
    contentRedacted: 'ok',
    ts: '2026-04-18T09:02:00Z',
  },
];

const BOOKMARKS = [
  {
    id: 'bm-1',
    sessionId: 'sess-rec-1',
    label: 'initial repro',
    source: 'record',
    startTs: '2026-04-18T09:00:10Z',
    endTs: '2026-04-18T09:01:30Z',
  },
  {
    id: 'bm-2',
    sessionId: 'sess-rec-1',
    label: 'focus window',
    source: 'focus',
    startTs: '2026-04-18T09:01:00Z',
    endTs: '2026-04-18T09:02:00Z',
  },
];

type FetchStubOpts = {
  onBookmarkPost?: (body: Record<string, unknown>) => void;
  onBookmarkPatch?: (id: string, body: Record<string, unknown>) => void;
};

function installFetchStub(opts: FetchStubOpts = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/sessions') && method === 'GET') {
        return jsonRes(SESSIONS);
      }
      if (/\/api\/sessions\/.+\/events/.test(url) && method === 'GET') {
        return jsonRes(EVENTS);
      }
      if (url.includes('/api/bookmarks') && method === 'GET') {
        return jsonRes(BOOKMARKS);
      }
      if (url.endsWith('/api/bookmarks') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        opts.onBookmarkPost?.(body);
        return jsonRes({ id: 'bm-new-1', ...body }, 201);
      }
      const patchMatch = url.match(/\/api\/bookmarks\/([^/?]+)$/);
      if (patchMatch && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        opts.onBookmarkPatch?.(patchMatch[1]!, body);
        return jsonRes({ id: patchMatch[1], ...body });
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    })
  );
}

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetStores(): void {
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: null,
    events: [],
    eventsLoading: false,
    eventsError: null,
    expandedSpans: new Set(),
  });
  useSelectionStore.setState({
    selectedSpanId: null,
    drawerOpen: false,
    helpOpen: false,
    focusRange: {},
    contextMenuRowId: null,
  });
  useRecordingStore.setState({
    isRecording: false,
    currentBookmarkId: null,
    startTs: null,
    label: null,
  });
  useBookmarksStore.setState({ bySession: {}, loading: false, error: null });
}

beforeEach(() => {
  installFetchStub();
  resetStores();
  // Tests render <App/>, which is now router-driven — point the URL at the
  // detail route so AppShell mounts (L2.1 wrapping).
  window.history.pushState({}, '', '/session/sess-rec-1');
  // happy-dom doesn't define window.prompt; vi.spyOn requires the method to
  // exist as a function on the target before it can replace it.
  if (typeof window.prompt !== 'function') {
    Object.defineProperty(window, 'prompt', {
      value: (_msg?: string, _default?: string): string | null => '',
      writable: true,
      configurable: true,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('recording store', () => {
  it('start sets isRecording=true + startTs; stop clears', async () => {
    let postedBody: Record<string, unknown> | undefined;
    installFetchStub({
      onBookmarkPost: (b) => {
        postedBody = b;
      },
    });

    await act(async () => {
      await useRecordingStore.getState().startRecording('sess-rec-1', 'quick repro');
    });
    const after = useRecordingStore.getState();
    expect(after.isRecording).toBe(true);
    expect(typeof after.startTs).toBe('string');
    expect(after.currentBookmarkId).toBeTruthy();
    expect(postedBody?.sessionId).toBe('sess-rec-1');
    expect(postedBody?.source).toBe('record');
    expect(postedBody?.label).toBe('quick repro');

    await act(async () => {
      await useRecordingStore.getState().stopRecording();
    });
    const cleared = useRecordingStore.getState();
    expect(cleared.isRecording).toBe(false);
    expect(cleared.currentBookmarkId).toBeNull();
    expect(cleared.startTs).toBeNull();
  });
});

describe('RecordButton', () => {
  it('renders "rec" label when idle and POSTs to /api/bookmarks on click', async () => {
    // L3.5: clicking the record button opens an inline label prompt first.
    // The user edits (or accepts) the pre-filled label, then submits — only
    // then do we POST /api/bookmarks.
    let postedBody: Record<string, unknown> | undefined;
    installFetchStub({ onBookmarkPost: (b) => (postedBody = b) });

    useSessionStore.setState({ selectedSessionId: 'sess-rec-1' });
    render(<RecordButton />);

    const btn = screen.getByTestId('record-button');
    expect(btn.textContent).toMatch(/rec/i);

    // Click opens the inline label prompt dialog.
    await act(async () => {
      fireEvent.click(btn);
    });
    const input = await screen.findByTestId('record-label-input');
    expect(input).toBeTruthy();

    // Type a label + submit via the amber RECORD button.
    await act(async () => {
      fireEvent.change(input, { target: { value: 'my label' } });
    });
    const submit = screen.getByTestId('record-label-submit');
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => {
      expect(postedBody).toBeDefined();
    });
    expect(postedBody!.label).toBe('my label');
    expect(postedBody!.source).toBe('record');
    expect(postedBody!.sessionId).toBe('sess-rec-1');
    expect(useRecordingStore.getState().isRecording).toBe(true);
  });

  it('shows pulsing dot + timer while recording; Stop PATCHes endTs', async () => {
    let patched: { id: string; body: Record<string, unknown> } | null = null;
    installFetchStub({
      onBookmarkPatch: (id, body) => {
        patched = { id, body };
      },
    });

    useSessionStore.setState({ selectedSessionId: 'sess-rec-1' });
    useRecordingStore.setState({
      isRecording: true,
      currentBookmarkId: 'bm-x',
      startTs: new Date().toISOString(),
      label: 'rec',
    });

    render(<RecordButton />);
    const btn = screen.getByTestId('record-button');
    expect(btn.textContent?.toLowerCase()).toContain('stop');
    // pulsing dot
    expect(screen.getByTestId('record-pulse')).toBeTruthy();

    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(patched).not.toBeNull();
    });
    expect(patched!.id).toBe('bm-x');
    expect(patched!.body.endTs).toBeDefined();
  });
});

describe('TimelineRow right-click context menu', () => {
  it('contextmenu -> Focus from here updates selection.focusRange.startTs', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    const rows = screen.getAllByTestId('timeline-row');
    const target = rows.find((r) => r.getAttribute('data-span-id') === 'span-t-1')!;
    fireEvent.contextMenu(target);

    const menu = await screen.findByTestId('row-context-menu');
    expect(menu).toBeTruthy();
    const focusFromHere = screen.getByTestId('ctx-focus-start');
    await act(async () => {
      fireEvent.click(focusFromHere);
    });
    const focus = useSelectionStore.getState().focusRange;
    expect(focus.startTs).toBe('2026-04-18T09:01:00Z');
  });
});

describe('FocusBar', () => {
  it('renders with event count + token sum for active focus range', () => {
    useSessionStore.setState({
      selectedSessionId: 'sess-rec-1',
      events: EVENTS as Parameters<typeof useSessionStore.setState>[0] extends infer _
        ? typeof EVENTS
        : never,
    });
    useSelectionStore.setState({
      focusRange: { startTs: '2026-04-18T09:00:30Z', endTs: '2026-04-18T09:02:30Z' },
    });

    render(<FocusBar />);
    const bar = screen.getByTestId('focus-bar');
    expect(bar.textContent).toMatch(/event/i);
    expect(bar.textContent).toMatch(/token/i);
    // span-t-1 + span-u-2 are in range; span-u-1 is before.
    // ledger tokens: 110 + 55 = 165
    expect(bar.textContent).toContain('165');
  });

  it('Clear button clears focus range', async () => {
    useSelectionStore.setState({
      focusRange: { startTs: '2026-04-18T09:00:30Z' },
    });
    render(<FocusBar />);
    const clearBtn = screen.getByTestId('focus-clear');
    await act(async () => {
      fireEvent.click(clearBtn);
    });
    expect(useSelectionStore.getState().focusRange.startTs).toBeUndefined();
  });
});

describe('Sessions landing bookmark nesting', () => {
  // v0.2: the landing page (L1) is where bookmarks nest under a session row.
  // The old Mode-C SessionPicker inside the topbar no longer renders on the
  // session-detail route — the landing page owns that disclosure now.
  it('expand arrow reveals nested bookmarks for the session', async () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    // Wait for the sessions list to mount.
    const expandBtn = await screen.findByTestId('session-expand-sess-rec-1');
    await act(async () => {
      fireEvent.click(expandBtn);
    });
    await waitFor(() => {
      expect(screen.getByTestId('bookmark-row-bm-1')).toBeTruthy();
      expect(screen.getByTestId('bookmark-row-bm-2')).toBeTruthy();
    });
    const bm1 = screen.getByTestId('bookmark-row-bm-1');
    expect(bm1.textContent).toContain('initial repro');
  });
});

describe('Timeline focus-range dim (BUG-5)', () => {
  it('no focus range → all rows render at full opacity', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    const rows = screen.getAllByTestId('timeline-row');
    for (const row of rows) {
      const wrapper = row.parentElement!;
      const op = wrapper.style.opacity;
      // Default focusRange = {} → inFocusRange returns true → opacity ''/1.
      expect(op === '' || op === '1').toBe(true);
    }
  });

  it('focus range [09:00:30, 09:01:30] dims out-of-range rows to 0.4', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    await act(async () => {
      useSelectionStore.setState({
        focusRange: {
          startTs: '2026-04-18T09:00:30Z',
          endTs: '2026-04-18T09:01:30Z',
        },
      });
    });

    const rows = screen.getAllByTestId('timeline-row');
    const byId = new Map<string, HTMLElement>();
    for (const r of rows) {
      const id = r.getAttribute('data-span-id');
      if (id) byId.set(id, r);
    }

    // span-u-1 at 09:00:05Z → before start → dimmed.
    const u1 = byId.get('span-u-1')!;
    expect(u1.parentElement!.style.opacity).toBe('0.4');

    // span-u-2 at 09:02:00Z → after end → dimmed.
    const u2 = byId.get('span-u-2')!;
    expect(u2.parentElement!.style.opacity).toBe('0.4');

    // span-t-1 at 09:01:00Z → in-range → full opacity.
    const t1 = byId.get('span-t-1')!;
    const t1op = t1.parentElement!.style.opacity;
    expect(t1op === '' || t1op === '1').toBe(true);
  });

  it('clearFocus restores all rows to full opacity', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    await act(async () => {
      useSelectionStore.setState({
        focusRange: {
          startTs: '2026-04-18T09:00:30Z',
          endTs: '2026-04-18T09:01:30Z',
        },
      });
    });
    // Confirm some row is dimmed first.
    const dimmedBefore = screen
      .getAllByTestId('timeline-row')
      .some((r) => r.parentElement!.style.opacity === '0.4');
    expect(dimmedBefore).toBe(true);

    await act(async () => {
      useSelectionStore.getState().clearFocus();
    });

    const rows = screen.getAllByTestId('timeline-row');
    for (const row of rows) {
      const op = row.parentElement!.style.opacity;
      expect(op === '' || op === '1').toBe(true);
    }
  });
});

describe('Cmd+Shift+R hotkey', () => {
  it('toggles recording when Cmd+Shift+R is pressed', async () => {
    let postCount = 0;
    installFetchStub({ onBookmarkPost: () => postCount++ });
    useSessionStore.setState({ selectedSessionId: 'sess-rec-1' });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('hotkey');

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('app-shell')).toBeTruthy();
    });

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'R',
          code: 'KeyR',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        })
      );
    });

    await waitFor(() => {
      expect(postCount).toBe(1);
    });
    expect(useRecordingStore.getState().isRecording).toBe(true);
    promptSpy.mockRestore();
  });
});
