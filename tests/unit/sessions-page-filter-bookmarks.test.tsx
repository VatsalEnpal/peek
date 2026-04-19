// @vitest-environment happy-dom
/**
 * L2.4 + L2.5 — SessionsPage filter + bookmark nesting.
 *
 * Coverage matrix (L2.4):
 *   - Typing in the search input filters visible session rows.
 *   - Empty query restores the full list.
 *   - No-matches branch renders the "no matches" empty state.
 *
 * Coverage matrix (L2.5):
 *   - Chevron starts closed — no bookmark list rendered.
 *   - Clicking the chevron triggers `GET /api/bookmarks?sessionId=` and
 *     renders each returned bookmark row.
 *   - Sessions with zero bookmarks render the "(no bookmarks)" empty state.
 *   - Collapsing the row hides the bookmark list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SessionsPage, sessionMatches } from '../../src/pages/SessionsPage';
import { useSessionStore, type SessionSummary } from '../../src/stores/session';
import { useBookmarksStore } from '../../src/stores/bookmarks';

const NOW = new Date('2026-04-19T12:00:00Z');

function isoHoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

const SESSIONS: SessionSummary[] = [
  {
    id: 'sess-alpha',
    label: 'alpha · "the plan" · main · 2h',
    slug: 'alpha-slug',
    gitBranch: 'main',
    firstPrompt: 'draft the launch plan',
    turnCount: 3,
    totalTokens: 10_000,
    timeAgo: '2h ago',
    startTs: isoHoursAgo(2),
    endTs: isoHoursAgo(1),
  },
  {
    id: 'sess-beta',
    label: 'beta · "fix bug" · dev · 20h',
    slug: 'beta-slug',
    gitBranch: 'dev',
    firstPrompt: 'investigate the rate limiter bug',
    turnCount: 8,
    totalTokens: 22_000,
    timeAgo: '20h ago',
    startTs: isoHoursAgo(20),
    endTs: isoHoursAgo(19),
  },
  {
    id: 'sess-gamma',
    label: 'gamma · "refactor" · release · 2d',
    slug: 'gamma-slug',
    gitBranch: 'release/0.2',
    firstPrompt: 'refactor the ImportDialog',
    turnCount: 5,
    totalTokens: 5_000,
    timeAgo: '2d ago',
    startTs: isoHoursAgo(50),
    endTs: isoHoursAgo(49),
  },
];

function seedStore(): void {
  useSessionStore.setState({
    sessions: SESSIONS,
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: null,
    events: [],
    eventsLoading: false,
    eventsError: null,
    expandedSpans: new Set(),
    fetchSessions: async (): Promise<void> => {
      /* no-op */
    },
  });
  useBookmarksStore.setState({ bySession: {}, loading: false, error: null });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <SessionsPage />
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Fetch stub — returns bookmark lists keyed by sessionId.
// ---------------------------------------------------------------------------

function installBookmarksStub(mock: Record<string, unknown[]>): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const match = /sessionId=([^&]+)/.exec(url);
    const sid = match ? decodeURIComponent(match[1]!) : '';
    const body = mock[sid] ?? [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// L2.4 — search filter
// ---------------------------------------------------------------------------

describe('L2.4 — sessions filter', () => {
  it('sessionMatches: case-insensitive substring across prompt/slug/branch', () => {
    expect(sessionMatches(SESSIONS[0]!, '')).toBe(true);
    expect(sessionMatches(SESSIONS[0]!, 'LAUNCH')).toBe(true); // prompt match
    expect(sessionMatches(SESSIONS[1]!, 'dev')).toBe(true); // branch match
    expect(sessionMatches(SESSIONS[2]!, 'gamma')).toBe(true); // slug match
    expect(sessionMatches(SESSIONS[0]!, 'nonsense-xyz')).toBe(false);
  });

  it('typing in the search input reduces visible rows', async () => {
    renderPage();
    // All 3 rows visible initially.
    expect(screen.getAllByTestId(/^session-row-/).length).toBe(3);

    const input = screen.getByTestId('sessions-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bug' } });

    await waitFor(() => {
      const rows = screen.getAllByTestId(/^session-row-/);
      expect(rows.length).toBe(1);
      expect(rows[0]!.getAttribute('data-session-id')).toBe('sess-beta');
    });
  });

  it('clearing the query restores the full list', async () => {
    renderPage();
    const input = screen.getByTestId('sessions-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bug' } });
    await waitFor(() => expect(screen.getAllByTestId(/^session-row-/).length).toBe(1));

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByTestId(/^session-row-/).length).toBe(3));
  });

  it('renders "no matches" empty state when filter reduces to 0 rows', async () => {
    renderPage();
    const input = screen.getByTestId('sessions-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'qqqqzzz-never-matches' } });

    await waitFor(() => {
      expect(screen.getByTestId('sessions-no-matches')).toBeDefined();
    });
    expect(screen.queryAllByTestId(/^session-row-/).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L2.5 — bookmark nesting
// ---------------------------------------------------------------------------

describe('L2.5 — bookmark nesting', () => {
  it('chevron starts closed — no bookmark list rendered', () => {
    const stub = installBookmarksStub({});
    renderPage();
    expect(screen.queryByTestId('bookmarks-list-sess-alpha')).toBeNull();
    expect(screen.queryByTestId('bookmarks-empty-sess-alpha')).toBeNull();
    // No bookmark fetch happens until the chevron is clicked.
    expect(stub.calls.length).toBe(0);
    stub.restore();
  });

  it('clicking chevron fetches and renders bookmarks', async () => {
    const stub = installBookmarksStub({
      'sess-alpha': [
        {
          id: 'bm-1',
          sessionId: 'sess-alpha',
          label: 'important moment',
          source: 'record',
          startTs: '2026-04-19T10:00:00Z',
        },
      ],
    });

    renderPage();
    fireEvent.click(screen.getByTestId('session-expand-sess-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('bookmarks-list-sess-alpha')).toBeDefined();
    });
    expect(screen.getByTestId('bookmark-row-bm-1')).toBeDefined();
    expect(screen.getByTestId('bookmark-row-bm-1').textContent).toContain('important moment');
    expect(stub.calls.some((u) => /bookmarks\?sessionId=sess-alpha/.test(u))).toBe(true);

    stub.restore();
  });

  it('shows "(no bookmarks)" when the session has none', async () => {
    const stub = installBookmarksStub({
      'sess-beta': [],
    });

    renderPage();
    fireEvent.click(screen.getByTestId('session-expand-sess-beta'));

    await waitFor(() => {
      expect(screen.getByTestId('bookmarks-empty-sess-beta')).toBeDefined();
    });

    stub.restore();
  });

  it('chevron toggles expansion back off', async () => {
    const stub = installBookmarksStub({
      'sess-alpha': [],
    });

    renderPage();
    const chev = screen.getByTestId('session-expand-sess-alpha');

    fireEvent.click(chev);
    await waitFor(() => {
      expect(screen.getByTestId('bookmarks-empty-sess-alpha')).toBeDefined();
    });

    fireEvent.click(chev);
    await waitFor(() => {
      expect(screen.queryByTestId('bookmarks-empty-sess-alpha')).toBeNull();
    });

    stub.restore();
  });
});
