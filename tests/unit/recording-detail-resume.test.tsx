// @vitest-environment happy-dom
/**
 * v0.3-resume — regression tests for the 4 tester-reported BLOCKING issues
 * on /recording/:id:
 *
 *   #11 lifecycle toggle is no-op (doesn't actually filter rows)
 *   #12 timeline duplicates (LEDGER + TOOL_CALL render for same event)
 *   #13 top-level tool_uses render only as LEDGER, never as TOOL_CALL
 *   #14 subagent group shows "0 children" while nested tools render flat
 *
 * Test harness mocks fetch for /api/recordings/:id and .../events so we can
 * render with surgically-crafted event arrays and make exact DOM assertions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RecordingDetailPage } from '../../src/pages/RecordingDetailPage';
import type { RecordingSummary } from '../../src/stores/recordings';

const SUMMARY: RecordingSummary = {
  id: 'rec-resume',
  name: 'resume-tests',
  sessionId: 'sess-R',
  startTs: '2026-04-19T18:25:00.000Z',
  endTs: '2026-04-19T18:26:00.000Z',
  status: 'closed',
  createdAt: '2026-04-19T18:25:00.000Z',
  durationMs: 60_000,
  toolCount: 4,
  apiCount: 1,
  totalTokens: 1000,
};

type Ev = Record<string, unknown>;

function mockFetch(events: Ev[]): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.endsWith('/api/recordings/rec-resume')) {
      return new Response(JSON.stringify(SUMMARY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/api/recordings/rec-resume/events')) {
      const includeLifecycle = u.includes('includeLifecycle=1');
      // Server filters out span rows whose type is in LIFECYCLE_TYPES when
      // includeLifecycle is off. It does NOT filter LEDGER rows. Mirror that
      // exactly so the client-side filter is what the test exercises.
      const LIFECYCLE_SPAN_TYPES = new Set([
        'bridge_status',
        'command_permissions',
        'mcp_instructions_delta',
        'deferred_tools_delta',
        'stop_hook_summary',
        'auto_mode',
        'turn_duration',
        'file-history-snapshot',
        'permission-mode',
        'away_summary',
        'last-prompt',
        'queue-operation',
        'task_reminder',
      ]);
      const body = includeLifecycle
        ? events
        : events.filter((e) => !(e.kind === 'span' && LIFECYCLE_SPAN_TYPES.has(String(e.type))));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/recording/rec-resume']}>
      <Routes>
        <Route path="/recording/:id" element={<RecordingDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() =>
    expect(screen.getByTestId('recording-detail-header').textContent).toContain('resume-tests')
  );
}

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
});

// ---------------------------------------------------------------------------
// #12 — duplicate rows
// ---------------------------------------------------------------------------

describe('RecordingDetailPage — #12 no duplicate rows', () => {
  const EVENTS: Ev[] = [
    {
      kind: 'span',
      id: 'span-bash-1',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Bash',
      startTs: '2026-04-19T18:25:10.000Z',
      tokensConsumed: 120,
    },
    {
      // Ledger entry introduced by the same tool_use — a duplicate in wire.
      kind: 'ledger',
      id: 'ledger-bash-1',
      sessionId: 'sess-R',
      source: 'tool_use',
      introducedBySpanId: 'span-bash-1',
      tokens: 120,
      ts: '2026-04-19T18:25:10.000Z',
    },
  ];

  beforeEach(() => {
    mockFetch(EVENTS);
  });

  it('renders exactly one row for a tool_use + its introducing ledger entry', async () => {
    await renderPage();
    expect(screen.getByTestId('tool-row-span-bash-1')).toBeTruthy();
    expect(screen.queryByTestId('tool-row-ledger-bash-1')).toBeNull();
  });

  it('the surviving row shows TOOL_CALL / Bash (not LEDGER)', async () => {
    await renderPage();
    const row = screen.getByTestId('tool-row-span-bash-1');
    expect(row.textContent).toContain('TOOL_CALL');
    expect(row.textContent).toContain('Bash');
    expect(row.textContent).not.toContain('LEDGER');
  });
});

// ---------------------------------------------------------------------------
// #11 — lifecycle toggle must actually filter rows client-side
// ---------------------------------------------------------------------------

describe('RecordingDetailPage — #11 lifecycle toggle filters client-side', () => {
  const EVENTS: Ev[] = [
    {
      kind: 'span',
      id: 'span-real',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Read',
      startTs: '2026-04-19T18:25:05.000Z',
    },
    {
      // Ledger entry with no corresponding span — should be hidden by
      // default as debug noise, revealed when the toggle is on.
      kind: 'ledger',
      id: 'ledger-orphan',
      sessionId: 'sess-R',
      source: 'attachment',
      ts: '2026-04-19T18:25:06.000Z',
    },
    {
      kind: 'span',
      id: 'span-unknown',
      sessionId: 'sess-R',
      type: 'unknown',
      name: 'queue-operation',
      startTs: '2026-04-19T18:25:07.000Z',
    },
  ];

  beforeEach(() => {
    mockFetch(EVENTS);
  });

  it('hides LEDGER and UNKNOWN rows by default', async () => {
    await renderPage();
    expect(screen.getByTestId('tool-row-span-real')).toBeTruthy();
    expect(screen.queryByTestId('tool-row-ledger-orphan')).toBeNull();
    expect(screen.queryByTestId('tool-row-span-unknown')).toBeNull();
  });

  it('reveals them after the lifecycle toggle is clicked', async () => {
    await renderPage();
    const toggle = screen.getByTestId('lifecycle-toggle');
    act(() => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(screen.getByTestId('tool-row-ledger-orphan')).toBeTruthy());
    expect(screen.getByTestId('tool-row-span-unknown')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #13 — top-level tool_call spans render as TOOL_CALL, not LEDGER
// ---------------------------------------------------------------------------

describe('RecordingDetailPage — #13 top-level tool_call classification', () => {
  const EVENTS: Ev[] = [
    // Top-level tool_use that happens to have BOTH a span (type=tool_call)
    // AND an introducing ledger entry — the server returns both. The
    // renderer must pick the span's classification, not the ledger's.
    {
      kind: 'span',
      id: 'span-toplevel',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Bash',
      startTs: '2026-04-19T18:25:27.000Z',
      tokensConsumed: 125,
      inputs: { command: 'curl POST /api/markers type=end' },
    },
    {
      kind: 'ledger',
      id: 'ledger-toplevel',
      sessionId: 'sess-R',
      source: 'tool_use',
      introducedBySpanId: 'span-toplevel',
      tokens: 125,
      ts: '2026-04-19T18:25:27.000Z',
    },
  ];

  beforeEach(() => {
    mockFetch(EVENTS);
  });

  it('top-level tool_use shows as TOOL_CALL Bash (not LEDGER tool_use)', async () => {
    await renderPage();
    const row = screen.getByTestId('tool-row-span-toplevel');
    expect(row.textContent).toContain('TOOL_CALL');
    expect(row.textContent).toContain('Bash');
    // Ledger dupe stays hidden even for top-level tool_uses.
    expect(screen.queryByTestId('tool-row-ledger-toplevel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #14 — subagent group grouping + count + collapse
// ---------------------------------------------------------------------------

describe('RecordingDetailPage — #14 subagent grouping', () => {
  // Mirrors the shape of a real CC recording (tester fixture tick-6):
  // the subagent's child spans carry `parentSpanId` values that reference
  // spans which live OUTSIDE the event window (child-session assistant
  // message uuids not spliced in, or spliced in and then filtered by the
  // recording's ts range). That makes them appear as orphans. The fix
  // must attribute them to the most-recent preceding subagent.
  const EVENTS: Ev[] = [
    // Pre-subagent top-level event — must NOT be attributed to the
    // subagent (it happened before).
    {
      kind: 'span',
      id: 'pre-user',
      sessionId: 'sess-R',
      type: 'user_prompt',
      startTs: '2026-04-19T18:25:02.000Z',
      parentSpanId: 'orphan-before',
    },
    {
      kind: 'span',
      id: 'span-subagent',
      sessionId: 'sess-R',
      type: 'subagent',
      name: 'Agent: security',
      startTs: '2026-04-19T18:25:06.000Z',
      parentSpanId: 'orphan-A',
      metadata: { agentId: 'agent-xyz', agentDescription: 'scan the repo' },
    },
    // Orphan child: parentSpanId references a span not present in events
    // (child session assistant message 80556fba). Must be attributed to
    // the preceding subagent by the orphan-after-subagent heuristic.
    {
      kind: 'span',
      id: 'child-bash',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Bash',
      startTs: '2026-04-19T18:25:08.000Z',
      parentSpanId: 'orphan-assistant-1',
    },
    {
      kind: 'span',
      id: 'child-grep',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Grep',
      startTs: '2026-04-19T18:25:09.000Z',
      parentSpanId: 'orphan-assistant-2',
    },
    {
      kind: 'span',
      id: 'child-read',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Read',
      startTs: '2026-04-19T18:25:09.500Z',
      parentSpanId: 'orphan-assistant-2',
    },
    // Post-subagent top-level event — parent points to an in-events span
    // that itself resolves to a top-level (not the subagent). Must stay
    // at the top level.
    {
      kind: 'span',
      id: 'post-api',
      sessionId: 'sess-R',
      type: 'api_call',
      startTs: '2026-04-19T18:25:23.000Z',
      parentSpanId: 'post-user',
    },
    {
      kind: 'span',
      id: 'post-user',
      sessionId: 'sess-R',
      type: 'user_prompt',
      startTs: '2026-04-19T18:25:22.000Z',
      parentSpanId: 'orphan-tail',
    },
  ];

  beforeEach(() => {
    mockFetch(EVENTS);
  });

  it('subagent group reports the correct descendant count', async () => {
    await renderPage();
    const group = screen.getByTestId('subagent-group-span-subagent');
    // 3 orphan tool_calls between subagent and next top-level event.
    expect(group.textContent).toMatch(/3 children/);
    expect(group.textContent).not.toMatch(/0 children/);
  });

  it('renders nested tool rows inside the subagent group', async () => {
    await renderPage();
    const group = screen.getByTestId('subagent-group-span-subagent');
    const scope = within(group);
    expect(scope.getByTestId('tool-row-child-bash')).toBeTruthy();
    expect(scope.getByTestId('tool-row-child-read')).toBeTruthy();
    expect(scope.getByTestId('tool-row-child-grep')).toBeTruthy();
  });

  it('collapse button hides nested rows', async () => {
    await renderPage();
    const group = screen.getByTestId('subagent-group-span-subagent');
    const button = within(group).getByTestId('subagent-group-toggle-span-subagent');
    expect(within(group).queryByTestId('tool-row-child-bash')).toBeTruthy();
    act(() => {
      fireEvent.click(button);
    });
    expect(within(group).queryByTestId('tool-row-child-bash')).toBeNull();
  });

  it('nested child rows do NOT also render at the top level', async () => {
    await renderPage();
    const timeline = screen.getByTestId('recording-timeline');
    const topLevelRows = timeline.querySelectorAll(':scope > [data-testid^="tool-row-"]');
    const ids = Array.from(topLevelRows).map((e) => e.getAttribute('data-testid'));
    expect(ids).not.toContain('tool-row-child-bash');
    expect(ids).not.toContain('tool-row-child-read');
    expect(ids).not.toContain('tool-row-child-grep');
  });

  it('events that precede the subagent stay at the top level', async () => {
    await renderPage();
    const timeline = screen.getByTestId('recording-timeline');
    const topLevelRows = timeline.querySelectorAll(':scope > [data-testid^="tool-row-"]');
    const ids = Array.from(topLevelRows).map((e) => e.getAttribute('data-testid'));
    expect(ids).toContain('tool-row-pre-user');
  });

  it('events whose ancestor chain resolves to a non-subagent root stay at the top level', async () => {
    await renderPage();
    const timeline = screen.getByTestId('recording-timeline');
    const topLevelRows = timeline.querySelectorAll(':scope > [data-testid^="tool-row-"]');
    const ids = Array.from(topLevelRows).map((e) => e.getAttribute('data-testid'));
    // post-api has parent post-user (in events) whose parent is orphan-tail
    // AFTER the subagent window ended — they resolve to a non-subagent root.
    expect(ids).toContain('tool-row-post-api');
    expect(ids).toContain('tool-row-post-user');
  });
});

// ---------------------------------------------------------------------------
// #16 (reopened) — clicking anywhere on a tool row expands its details pane
//
// Pre-launch user-test: the visible chevron ▸ at the far-right of each row is
// a tiny, hard-to-hit target. A natural "click anywhere on the row to see
// more" interaction was missing — users clicking the command-text area saw
// nothing happen. The row body must ALSO toggle the tool-row-body panel so
// the hit area is generous and obvious.
// ---------------------------------------------------------------------------

describe('RecordingDetailPage — #16 row body is a click target, not just the chevron', () => {
  const EVENTS: Ev[] = [
    {
      kind: 'span',
      id: 'span-bash-click',
      sessionId: 'sess-R',
      type: 'tool_call',
      name: 'Bash',
      startTs: '2026-04-19T18:25:10.000Z',
      tokensConsumed: 45,
      inputs: { command: 'ls /tmp', description: 'list /tmp' },
      outputs: 'file-a\nfile-b\n',
    },
  ];

  beforeEach(() => {
    mockFetch(EVENTS);
  });

  it('clicking the row body (not the chevron) opens the inputs/outputs pane', async () => {
    await renderPage();
    // Body must NOT be in the DOM before the click.
    expect(screen.queryByTestId('tool-row-body-span-bash-click')).toBeNull();
    // Simulate a real user click on the row container — not the toggle button.
    const row = screen.getByTestId('tool-row-span-bash-click');
    act(() => {
      fireEvent.click(row);
    });
    // Body with inputs + outputs must now be visible.
    const body = await waitFor(() => screen.getByTestId('tool-row-body-span-bash-click'));
    expect(body.textContent).toContain('ls /tmp');
    expect(body.textContent).toContain('file-a');
  });

  it('a second click on the row body collapses the pane', async () => {
    await renderPage();
    const row = screen.getByTestId('tool-row-span-bash-click');
    act(() => {
      fireEvent.click(row);
    });
    await waitFor(() => screen.getByTestId('tool-row-body-span-bash-click'));
    act(() => {
      fireEvent.click(row);
    });
    await waitFor(() =>
      expect(screen.queryByTestId('tool-row-body-span-bash-click')).toBeNull()
    );
  });
});
