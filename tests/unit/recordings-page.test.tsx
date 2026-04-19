// @vitest-environment happy-dom
/**
 * L3.1 — Unit test for RecordingsPage.
 *
 * Landing page is now a table of recordings. Must:
 *   - Render a row per recording with Name / Started / Duration / Tools / API
 *     / Tokens / Status cells.
 *   - Show a live pulsing badge (data-testid=`recording-live-badge-<id>`) for
 *     rows whose status='recording' and a closed dot for others.
 *   - Order: open recordings pinned top, then by startTs desc.
 *   - Each row link points to `/recording/:id`.
 *   - Empty state renders the /peek_start NAME hint when there are no rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RecordingsPage } from '../../src/pages/RecordingsPage';
import { useRecordingsStore, type RecordingSummary } from '../../src/stores/recordings';

const RECORDINGS: RecordingSummary[] = [
  {
    id: 'rec-closed-1',
    name: 'refactor',
    sessionId: 'sess-A',
    startTs: '2026-04-19T10:00:00.000Z',
    endTs: '2026-04-19T10:05:00.000Z',
    status: 'closed',
    createdAt: '2026-04-19T10:00:00.000Z',
    durationMs: 5 * 60_000,
    toolCount: 12,
    apiCount: 3,
    totalTokens: 1234,
  },
  {
    id: 'rec-live',
    name: 'agentstudio-test',
    sessionId: 'sess-B',
    startTs: '2026-04-19T11:00:00.000Z',
    endTs: null,
    status: 'recording',
    createdAt: '2026-04-19T11:00:00.000Z',
    durationMs: null,
    toolCount: 4,
    apiCount: 1,
    totalTokens: 500,
  },
  {
    id: 'rec-older',
    name: 'ancient-debug',
    sessionId: 'sess-A',
    startTs: '2026-04-18T09:00:00.000Z',
    endTs: '2026-04-18T09:02:00.000Z',
    status: 'closed',
    createdAt: '2026-04-18T09:00:00.000Z',
    durationMs: 2 * 60_000,
    toolCount: 2,
    apiCount: 0,
    totalTokens: 60,
  },
];

function seed(recordings: RecordingSummary[] = RECORDINGS): void {
  useRecordingsStore.setState({
    recordings,
    loading: false,
    error: null,
    // Stub the action so the test's auto-fetch on mount is a noop and doesn't
    // flip `loading` back to true (which would mask the empty-state hint).
    fetchRecordings: () => Promise.resolve(),
  } as never);
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <RecordingsPage />
    </MemoryRouter>
  );
}

describe('RecordingsPage', () => {
  beforeEach(() => {
    seed();
  });

  afterEach(() => {
    cleanup();
    useRecordingsStore.setState({ recordings: [], loading: false, error: null } as never);
  });

  it('renders the PEEK brand', () => {
    renderPage();
    expect(screen.getByText('PEEK')).toBeTruthy();
  });

  it('renders one row per recording with the expected cells', () => {
    renderPage();
    const row = screen.getByTestId('recording-row-rec-closed-1');
    const scope = within(row);
    expect(scope.getByText('refactor')).toBeTruthy();
    // duration 5m 0s
    expect(scope.getByTestId('recording-duration').textContent).toContain('5m');
    // tools / api / tokens cells
    expect(scope.getByTestId('recording-tools').textContent).toContain('12');
    expect(scope.getByTestId('recording-api').textContent).toContain('3');
    expect(scope.getByTestId('recording-tokens').textContent).toContain('1,234');
  });

  it('pins open recordings above closed ones regardless of startTs', () => {
    renderPage();
    const rows = screen.getAllByTestId(/^recording-row-/);
    // Live first even though its startTs is AFTER rec-closed-1. Then closed
    // recordings by startTs desc.
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'recording-row-rec-live',
      'recording-row-rec-closed-1',
      'recording-row-rec-older',
    ]);
  });

  it('shows a live badge only for status=recording', () => {
    renderPage();
    expect(screen.queryByTestId('recording-live-badge-rec-live')).toBeTruthy();
    expect(screen.queryByTestId('recording-live-badge-rec-closed-1')).toBeNull();
  });

  it('each row links to /recording/:id', () => {
    renderPage();
    const link = screen.getByTestId('recording-row-rec-live').closest('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/recording/rec-live');
  });

  it('renders empty state with /peek_start hint when no recordings', () => {
    seed([]);
    renderPage();
    expect(screen.getByTestId('recordings-empty')).toBeTruthy();
    expect(screen.getByTestId('recordings-empty').textContent).toMatch(/peek_start/);
  });
});
