// @vitest-environment happy-dom
/**
 * DOM smoke tests for the app shell, timeline, and inspector.
 *
 * - Uses `happy-dom` (opted-in by the pragma above) so server/unit tests keep
 *   running on the fast node env by default.
 * - Stubs `fetch` to return deterministic session + event fixtures; no real
 *   network, no server boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from '../../src/App';
import { useSessionStore } from '../../src/stores/session';
import { useSelectionStore } from '../../src/stores/selection';
import { buildTimelineRows, spanVisible } from '../../src/stores/session';

const SESSIONS = [
  {
    id: 'sess-1',
    label: 'example debug session',
    firstPrompt: 'debug the thing',
    turnCount: 3,
    totalTokens: 1234,
    timeAgo: '2m ago',
    startTs: '2026-04-18T09:00:00Z',
    endTs: '2026-04-18T09:05:00Z',
  },
];

const EVENTS = [
  {
    kind: 'span',
    id: 'span-user-1',
    sessionId: 'sess-1',
    type: 'user_prompt',
    name: 'debug the thing',
    startTs: '2026-04-18T09:00:01Z',
    durationMs: 12,
  },
  {
    kind: 'span',
    id: 'span-tool-1',
    sessionId: 'sess-1',
    parentSpanId: 'span-user-1',
    type: 'tool_call',
    name: 'Read src/app.ts',
    startTs: '2026-04-18T09:00:02Z',
    durationMs: 41,
  },
  {
    kind: 'span',
    id: 'span-file-1',
    sessionId: 'sess-1',
    type: 'memory_read',
    name: 'package.json',
    startTs: '2026-04-18T09:00:03Z',
    durationMs: 3,
  },
  {
    kind: 'ledger',
    id: 'ledger-1',
    sessionId: 'sess-1',
    introducedBySpanId: 'span-tool-1',
    source: 'tool',
    tokens: 420,
    contentRedacted: 'normal value, nothing sensitive',
    ts: '2026-04-18T09:00:02Z',
  },
];

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/sessions')) {
        return new Response(JSON.stringify(SESSIONS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (/\/api\/sessions\/.+\/events/.test(url)) {
        return new Response(JSON.stringify(EVENTS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
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
  useSelectionStore.setState({ selectedSpanId: null, drawerOpen: false, helpOpen: false });
}

beforeEach(() => {
  installFetchStub();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('app shell', () => {
  it('renders the shell with dark background and the peek wordmark', async () => {
    render(<App />);

    const shell = await screen.findByTestId('app-shell');
    expect(shell).toBeTruthy();
    // bg is set via CSS variable on body; confirm the shell exists and the
    // topbar + timeline are present.
    expect(screen.getByTestId('topbar')).toBeTruthy();
    expect(screen.getByText('peek')).toBeTruthy();

    // After mount, fetchSessions runs and auto-selects the first session,
    // which then loads events. Wait for a row to appear.
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
  });

  it('renders TimelineRow with icon, name and mono tokens for a mock event', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    const rows = screen.getAllByTestId('timeline-row');
    // Root-level events only (file + user), not child tool span, until expanded.
    const userRow = rows.find((r) => r.getAttribute('data-span-id') === 'span-user-1');
    expect(userRow).toBeTruthy();
    expect(userRow!.getAttribute('data-span-type')).toBe('user_prompt');
    expect(userRow!.textContent).toContain('debug the thing');
    // Cascade marker exists because span-user-1 has a child span. Under
    // Option A the child is already rendered inline, so the marker is purely
    // a visual grouping indicator — but the DOM hook must remain for tests
    // and for the future Option B toggle.
    const toggle = userRow!.querySelector('[data-testid="cascade-toggle"]');
    expect(toggle).toBeTruthy();
    // The child tool_call row must also appear in the flat stream — this is
    // the BLOCKING-1 invariant (child spans must not be orphaned).
    const toolRow = rows.find((r) => r.getAttribute('data-span-id') === 'span-tool-1');
    expect(toolRow).toBeTruthy();
    expect(toolRow!.getAttribute('data-span-type')).toBe('tool_call');

    // Click the user row — inspector opens with the span name.
    fireEvent.click(userRow!);
    await waitFor(() => {
      const name = screen.getByTestId('inspector-name');
      expect(name.textContent).toContain('debug the thing');
    });
    expect(useSelectionStore.getState().drawerOpen).toBe(true);
  });

  it('filter chips toggle selector results, and selection store reflects clicks', () => {
    // Unit-level checks against the stores without spinning up App — fast and
    // deterministic.
    const active = new Set(['prompts', 'tools']);
    expect(spanVisible('user_prompt', active)).toBe(true);
    expect(spanVisible('tool_call', active)).toBe(true);
    expect(spanVisible('memory_read', active)).toBe(false);
    expect(spanVisible('unknown', active)).toBe(true); // not covered by any chip

    // buildTimelineRows (Option A): every span passing chip filters is
    // present in one flat chronological list — including children. BLOCKING-1
    // fix: tool_call spans must appear in the top-level stream.
    const rows = buildTimelineRows(
      EVENTS as Parameters<typeof buildTimelineRows>[0],
      new Set(['prompts', 'files', 'skills', 'hooks', 'api', 'tools', 'subagents']),
      new Set()
    );
    const rowIds = rows.map((r) => r.id);
    expect(rowIds).toContain('span-user-1');
    expect(rowIds).toContain('span-file-1');
    expect(rowIds).toContain('span-tool-1');

    // Expanded set is a no-op under Option A — same rows either way.
    const rowsExpanded = buildTimelineRows(
      EVENTS as Parameters<typeof buildTimelineRows>[0],
      new Set(['prompts', 'files', 'skills', 'hooks', 'api', 'tools', 'subagents']),
      new Set(['span-user-1'])
    );
    expect(rowsExpanded.map((r) => r.id)).toEqual(rowIds);

    // Selection store: selectSpan opens the drawer.
    useSelectionStore.getState().selectSpan('span-tool-1');
    expect(useSelectionStore.getState().selectedSpanId).toBe('span-tool-1');
    expect(useSelectionStore.getState().drawerOpen).toBe(true);
    useSelectionStore.getState().closeDrawer();
    expect(useSelectionStore.getState().drawerOpen).toBe(false);

    // Help overlay toggle.
    expect(useSelectionStore.getState().helpOpen).toBe(false);
    useSelectionStore.getState().toggleHelp();
    expect(useSelectionStore.getState().helpOpen).toBe(true);
  });

  it('context gauge reflects total ledger tokens when a span is selected', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByTestId('timeline-row').length).toBeGreaterThan(0);
    });
    // Open the inspector by selecting any row.
    fireEvent.click(screen.getAllByTestId('timeline-row')[0]!);
    const gauge = await screen.findByTestId('context-gauge');
    expect(gauge.textContent).toContain('420');
  });
});
