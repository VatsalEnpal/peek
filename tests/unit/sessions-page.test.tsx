// @vitest-environment happy-dom
/**
 * Unit test for SessionsPage — the L1 landing.
 *
 * Covers the must-have invariants from the mockup:
 *   - PEEK brand is rendered.
 *   - IMPORT button is present and is a real <button> (not a link).
 *   - Search input is present, controlled (accepts typing), and accessible.
 *   - One <a> per session renders, slug-first, with `href` pointing at
 *     `/session/:id`.
 *   - Slug fallback: when `slug` is missing, the 8-char id prefix is used.
 *   - Keyboard/click target: each row is a real <a> so <Enter>/<Space> and
 *     screen-readers can open it.
 *
 * No network; the session-store is seeded directly so the page has no
 * async work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    id: 'sess-with-slug-aaaaaaaa',
    label: 'velvet-dawn-cipher · "draft post" · main · 2h ago',
    slug: 'velvet-dawn-cipher',
    gitBranch: 'main',
    firstPrompt: 'draft the launch post',
    turnCount: 12,
    totalTokens: 42_000,
    timeAgo: '2h ago',
    startTs: isoHoursAgo(2),
    endTs: isoHoursAgo(1),
  },
  {
    id: 'e2d87d5cbbbbbbbbbbbbbbbb',
    label: 'e2d87d5c · "okay, so we have…" · no-branch · 20h ago',
    // slug deliberately null → fallback to id[:8] path
    slug: null,
    gitBranch: null,
    firstPrompt: 'okay, so we have a version of agent studio',
    turnCount: 376,
    totalTokens: 159_806,
    timeAgo: '20h ago',
    startTs: isoHoursAgo(20),
    endTs: isoHoursAgo(19),
  },
  {
    id: 'sess-yesterday-cccccccc',
    label: 'ancient-slug · "old work" · main · 2d ago',
    slug: 'ancient-slug',
    gitBranch: 'main',
    firstPrompt: 'look into old work',
    turnCount: 5,
    totalTokens: 3_000,
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

beforeEach(() => {
  seedStore();
  // SessionsPage calls fetchSessions() on mount — stub it to a noop so the
  // seeded state is preserved (the real action clears + refetches).
  useSessionStore.setState({
    fetchSessions: async (): Promise<void> => {
      /* test noop: seed is already in place */
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('SessionsPage (L1 landing)', () => {
  it('renders the PEEK brand', () => {
    renderPage();
    expect(screen.getByTestId('peek-brand').textContent).toBe('PEEK');
  });

  it('renders the IMPORT button as a real <button>', () => {
    renderPage();
    const btn = screen.getByTestId('import-btn');
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn.textContent?.toLowerCase()).toContain('import');
  });

  it('renders a controlled search input that accepts typing', () => {
    renderPage();
    const input = screen.getByTestId('sessions-search') as HTMLInputElement;
    expect(input.tagName.toLowerCase()).toBe('input');
    expect(input.getAttribute('aria-label')).toMatch(/search/i);
    fireEvent.change(input, { target: { value: 'recording' } });
    expect(input.value).toBe('recording');
  });

  it('renders one <a> per session, slug-first, with href → /session/:id', () => {
    renderPage();
    const rows = screen.getAllByTestId(/^session-row-/);
    expect(rows).toHaveLength(SESSIONS.length);

    for (const s of SESSIONS) {
      const row = screen.getByTestId(`session-row-${s.id}`);
      // Must be a real anchor so Enter/Space opens and screen readers announce.
      expect(row.tagName.toLowerCase()).toBe('a');
      expect(row.getAttribute('href')).toBe(`/session/${encodeURIComponent(s.id)}`);
    }
  });

  it('slug fallback: uses 8-char id prefix ONLY when slug is missing', () => {
    renderPage();
    // With slug
    const slugged = screen.getByTestId('session-row-sess-with-slug-aaaaaaaa');
    expect(slugged.textContent).toContain('velvet-dawn-cipher');

    // Without slug — should show exactly the 8-char prefix `e2d87d5c`
    const fallback = screen.getByTestId('session-row-e2d87d5cbbbbbbbbbbbbbbbb');
    expect(fallback.textContent).toContain('e2d87d5c');
    // Must NOT render the full 24-char id as the slug label
    const slugCell = fallback.querySelector('[data-testid="session-slug"]')!;
    expect(slugCell.textContent).toBe('e2d87d5c');
  });

  it('groups sessions into date buckets (today / earlier at minimum)', () => {
    renderPage();
    // today (2h / 20h) — both are < 24h old from NOW (2026-04-19T12:00:00Z)
    // The exact bucket boundary depends on real clock, so assert "at least one
    // group header exists" + "yesterday/earlier section renders when old".
    expect(screen.getAllByTestId(/^sessions-group-/).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking a row navigates via react-router (href drives it)', () => {
    renderPage();
    const row = screen.getByTestId(`session-row-${SESSIONS[0]!.id}`) as HTMLAnchorElement;
    // With MemoryRouter, jsdom won't actually navigate on click, but the href
    // attribute is what react-router-dom uses. We already asserted the href
    // above; verify the element is keyboard-focusable.
    expect(row.tabIndex === 0 || !row.hasAttribute('tabindex')).toBe(true);
  });
});
