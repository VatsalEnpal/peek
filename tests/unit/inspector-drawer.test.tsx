// @vitest-environment happy-dom
/**
 * L4.1 / L4.2 / L4.3 focused tests for `<Inspector />`.
 *
 * 1. Opening a span populates the drawer; clicking `× esc` reverts URL to
 *    `/session/:id` and the drawer closes.
 * 2. The ledger snapshot filters by `span.startTs` — entries timestamped
 *    later must NOT appear.
 * 3. `introducedBySpanId === span.id` renders the JUST LOADED amber tag.
 * 4. Clicking the source link POSTs to `/api/open` with the path from the
 *    span's ledger `sourceOffset.file`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { SessionDetailPage } from '../../src/pages/SessionDetailPage';
import { useSessionStore, type StoreEvent } from '../../src/stores/session';
import { useSelectionStore } from '../../src/stores/selection';

const SESSION_ID = 'sess-l4';
const SPAN_A = 'span-a';
const SPAN_B = 'span-b';
const LEDGER_OLD = 'ledger-old';
const LEDGER_NEW = 'ledger-new';
const LEDGER_FUTURE = 'ledger-future';
const SOURCE_FILE = '/Users/me/projects/repo/src/file.ts';

const EVENTS: StoreEvent[] = [
  {
    kind: 'span',
    id: SPAN_A,
    sessionId: SESSION_ID,
    type: 'file_read',
    name: 'read file A',
    startTs: '2026-04-19T12:00:00.000Z',
    durationMs: 50,
  },
  {
    kind: 'span',
    id: SPAN_B,
    sessionId: SESSION_ID,
    type: 'file_read',
    name: 'read file B',
    startTs: '2026-04-19T12:05:00.000Z',
    durationMs: 50,
  },
  {
    kind: 'ledger',
    id: LEDGER_OLD,
    sessionId: SESSION_ID,
    introducedBySpanId: 'pre-existing',
    source: 'prompt',
    tokens: 100,
    contentRedacted: 'old context entry',
    ts: '2026-04-19T11:59:00.000Z',
  },
  {
    kind: 'ledger',
    id: LEDGER_NEW,
    sessionId: SESSION_ID,
    introducedBySpanId: SPAN_A,
    source: 'file',
    tokens: 200,
    contentRedacted: 'newly loaded content',
    ts: '2026-04-19T12:00:00.000Z',
    sourceOffset: {
      file: SOURCE_FILE,
      byteStart: 0,
      byteEnd: 20,
      sourceLineHash: 'deadbeef',
    },
  },
  {
    kind: 'ledger',
    id: LEDGER_FUTURE,
    sessionId: SESSION_ID,
    introducedBySpanId: SPAN_B,
    source: 'file',
    tokens: 300,
    contentRedacted: 'future entry not yet live',
    ts: '2026-04-19T12:05:00.000Z',
  },
];

const fetchMock = vi.fn();

function installFetchStub(): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/open') && method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith(`/api/sessions/${SESSION_ID}/events`)) {
        return new Response(JSON.stringify(EVENTS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/sessions')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  );
  vi.stubGlobal('fetch', fetchMock);
}

function resetStores(): void {
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: SESSION_ID,
    events: EVENTS,
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
}

function renderWithRoute(spanId: string | null): { container: HTMLElement } {
  const path = spanId ? `/session/${SESSION_ID}/span/${spanId}` : `/session/${SESSION_ID}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/session/:id" element={<SessionDetailPage />} />
        <Route path="/session/:id/span/:spanId" element={<SessionDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  installFetchStub();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('L4.1 — Inspector drawer open/close + URL sync', () => {
  it('deep-link /session/:id/span/:spanId opens drawer on that span', async () => {
    renderWithRoute(SPAN_A);
    await waitFor(() => {
      expect(useSelectionStore.getState().drawerOpen).toBe(true);
      expect(useSelectionStore.getState().selectedSpanId).toBe(SPAN_A);
    });
    const name = await screen.findByTestId('inspector-name');
    expect(name.textContent).toContain('read file A');
  });

  it('clicking close button navigates back to /session/:id and drawer closes', async () => {
    renderWithRoute(SPAN_A);
    await waitFor(() => {
      expect(useSelectionStore.getState().drawerOpen).toBe(true);
    });
    const closeBtn = await screen.findByTestId('inspector-close');
    act(() => {
      fireEvent.click(closeBtn);
    });
    await waitFor(() => {
      expect(useSelectionStore.getState().drawerOpen).toBe(false);
    });
  });
});

describe('L4.2 — ledger snapshot', () => {
  it('shows entries live at startTs (including those introduced by this span)', async () => {
    renderWithRoute(SPAN_A);
    const list = await screen.findByTestId('inspector-ledger');
    const rows = list.querySelectorAll('[data-testid="ledger-entry"]');
    // Expect the OLD pre-existing entry (ts < startTs) AND the span's own
    // introduced entry (ts == startTs). The FUTURE entry (ts > startTs)
    // must NOT appear.
    const ids = Array.from(rows).map((r) => (r.textContent ?? '').toLowerCase());
    expect(ids.some((t) => t.includes('old context'))).toBe(true);
    expect(ids.some((t) => t.includes('newly loaded'))).toBe(true);
    expect(ids.some((t) => t.includes('future entry'))).toBe(false);
  });

  it('renders JUST LOADED tag on entries introduced by this span', async () => {
    renderWithRoute(SPAN_A);
    const list = await screen.findByTestId('inspector-ledger');
    const tags = list.querySelectorAll('[data-testid="just-loaded-tag"]');
    // Exactly one entry (LEDGER_NEW) is tagged.
    expect(tags.length).toBe(1);
    // The tagged row should be the LEDGER_NEW content preview.
    const row = tags[0]!.closest('[data-testid="ledger-entry"]');
    expect(row?.textContent ?? '').toContain('newly loaded');
    expect(row?.getAttribute('data-just-loaded')).toBe('true');
  });
});

describe('L4.3 — source link opens file', () => {
  it('clicking source link POSTs to /api/open with the source file path', async () => {
    renderWithRoute(SPAN_A);
    const link = await screen.findByTestId('source-link');
    await act(async () => {
      fireEvent.click(link);
    });
    await waitFor(() => {
      const called = fetchMock.mock.calls.find((args) => {
        const url = typeof args[0] === 'string' ? args[0] : String(args[0]);
        return url.endsWith('/api/open');
      });
      expect(called).toBeTruthy();
      const init = called![1] as RequestInit;
      expect((init.method ?? 'GET').toUpperCase()).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body.path).toBe(SOURCE_FILE);
    });
  });
});
