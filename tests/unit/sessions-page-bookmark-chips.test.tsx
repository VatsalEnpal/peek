// @vitest-environment happy-dom
/**
 * Unit (L14): bookmark chips rendered inline on each session card.
 *
 * Contract:
 *   - A session with bookmarks shows a chip per bookmark in the card body.
 *   - Chip is clickable (Link) — navigates to the session detail page.
 *   - A session with zero bookmarks renders no chip row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SessionsPage } from '../../src/pages/SessionsPage';
import { useSessionStore, type SessionSummary } from '../../src/stores/session';
import { useBookmarksStore } from '../../src/stores/bookmarks';

const NOW = new Date('2026-04-19T12:00:00Z');

function isoHoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

const SESSIONS: SessionSummary[] = [
  {
    id: 'sess-with-bms',
    label: 'alpha · "plan" · main',
    slug: 'alpha',
    gitBranch: 'main',
    firstPrompt: 'Research G-Brain',
    turnCount: 3,
    totalTokens: 10_000,
    timeAgo: '2h ago',
    startTs: isoHoursAgo(2),
    endTs: isoHoursAgo(1),
    bookmarks: [
      {
        id: 'bm-1',
        sessionId: 'sess-with-bms',
        source: 'marker',
        label: 'Test_vatsal',
        startTs: isoHoursAgo(1.5),
      },
    ],
  },
  {
    id: 'sess-no-bms',
    label: 'beta · "other" · main',
    slug: 'beta',
    gitBranch: 'main',
    firstPrompt: 'Other thing',
    turnCount: 1,
    totalTokens: 1_000,
    timeAgo: '3h ago',
    startTs: isoHoursAgo(3),
    endTs: isoHoursAgo(2.5),
    bookmarks: [],
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
    collapsedSpans: new Set(),
    activeChips: new Set(),
  });
}

describe('SessionsPage bookmark chips (L14)', () => {
  beforeEach(() => {
    seedStore();
    useBookmarksStore.setState({ bySession: {}, loading: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a chip for each bookmark on a session with bookmarks', () => {
    render(
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>
    );

    const chipRow = screen.getByTestId('session-bookmark-chips-sess-with-bms');
    expect(chipRow).toBeTruthy();
    expect(chipRow.textContent).toContain('Test_vatsal');
  });

  it('does not render a chip row for sessions with no bookmarks', () => {
    render(
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>
    );
    expect(screen.queryByTestId('session-bookmark-chips-sess-no-bms')).toBeNull();
  });

  it('chip is a link that navigates to the session detail', () => {
    render(
      <MemoryRouter>
        <SessionsPage />
      </MemoryRouter>
    );
    const chip = screen.getByTestId('session-bookmark-chip-bm-1');
    expect(chip.tagName.toLowerCase()).toBe('a');
    expect(chip.getAttribute('href')).toContain('/session/sess-with-bms');
  });
});
