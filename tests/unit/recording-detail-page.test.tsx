// @vitest-environment happy-dom
/**
 * L4 — RecordingDetailPage unit tests.
 *
 * Covers:
 *  - header renders recording name + stats
 *  - tool_call rows render collapsed (name, target, tokens)
 *  - expanding a row reveals inputs + outputs
 *  - subagent events render as nested groups with agentId/description
 *  - lifecycle toggle filters `bridge_status`/`permission-mode` by default
 *  - scroll container pins outer height to 100dvh and inner flex:1/overflow:auto
 *  - back button links to `/`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RecordingDetailPage } from '../../src/pages/RecordingDetailPage';
import type { RecordingSummary } from '../../src/stores/recordings';

const SUMMARY: RecordingSummary = {
  id: 'rec-x',
  name: 'security-scan-test',
  sessionId: 'sess-A',
  startTs: '2026-04-19T14:32:01.000Z',
  endTs: '2026-04-19T14:44:05.000Z',
  status: 'closed',
  createdAt: '2026-04-19T14:32:01.000Z',
  durationMs: 12 * 60_000 + 4_000,
  toolCount: 5,
  apiCount: 2,
  totalTokens: 87_412,
};

const EVENTS = [
  // Plain tool_call events.
  {
    kind: 'span',
    id: 'span-read',
    sessionId: 'sess-A',
    type: 'tool_call',
    name: 'Read',
    startTs: '2026-04-19T14:32:06.000Z',
    tokensConsumed: 1242,
    inputs: { path: '/tmp/CLAUDE.md' },
    outputs: { content: '# CLAUDE\n...' },
  },
  {
    kind: 'span',
    id: 'span-grep',
    sessionId: 'sess-A',
    type: 'tool_call',
    name: 'Grep',
    startTs: '2026-04-19T14:32:07.000Z',
    tokensConsumed: 340,
    inputs: { pattern: 'onDrop' },
    outputs: { matches: 'src/…' },
  },
  // Lifecycle noise — filtered by default.
  {
    kind: 'span',
    id: 'span-bridge',
    sessionId: 'sess-A',
    type: 'bridge_status',
    startTs: '2026-04-19T14:32:08.000Z',
  },
  {
    kind: 'span',
    id: 'span-perm',
    sessionId: 'sess-A',
    type: 'permission-mode',
    startTs: '2026-04-19T14:32:09.000Z',
  },
  // Subagent span with two children inside it.
  {
    kind: 'span',
    id: 'span-sub',
    sessionId: 'sess-A',
    type: 'subagent',
    name: 'Agent: security',
    startTs: '2026-04-19T14:32:10.000Z',
    metadata: { agentId: 'agent-123', description: 'scan the repo' },
  },
  {
    kind: 'span',
    id: 'span-sub-child-1',
    sessionId: 'sess-A',
    type: 'tool_call',
    name: 'Bash',
    startTs: '2026-04-19T14:32:11.000Z',
    tokensConsumed: 95,
    parentSpanId: 'span-sub',
    inputs: { command: 'ls src' },
  },
  {
    kind: 'span',
    id: 'span-sub-child-2',
    sessionId: 'sess-A',
    type: 'api_call',
    name: 'opus',
    startTs: '2026-04-19T14:32:12.000Z',
    tokensConsumed: 3217,
    parentSpanId: 'span-sub',
  },
];

function mockFetch(): void {
  (globalThis as any).fetch = async (url: string | URL, opts?: RequestInit) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.endsWith('/api/recordings/rec-x')) {
      return new Response(JSON.stringify(SUMMARY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/api/recordings/rec-x/events')) {
      const includeLifecycle = u.includes('includeLifecycle=1');
      const body = includeLifecycle
        ? EVENTS
        : EVENTS.filter((e) => e.type !== 'bridge_status' && e.type !== 'permission-mode');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/recording/rec-x']}>
      <Routes>
        <Route path="/recording/:id" element={<RecordingDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
  // Wait for the async fetches to resolve.
  await waitFor(() =>
    expect(screen.getByTestId('recording-detail-header').textContent).toContain(
      'security-scan-test'
    )
  );
}

describe('RecordingDetailPage', () => {
  beforeEach(() => {
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as any).fetch;
  });

  it('renders header with name, duration, and stats', async () => {
    await renderPage();
    const h = screen.getByTestId('recording-detail-header');
    expect(h.textContent).toContain('security-scan-test');
    expect(h.textContent).toContain('12m 04s');
    expect(h.textContent).toContain('5');
    expect(h.textContent).toContain('2');
    expect(h.textContent).toContain('87,412');
  });

  it('back link points to /', async () => {
    await renderPage();
    const back = screen.getByTestId('recording-back');
    expect(back.getAttribute('href')).toBe('/');
  });

  it('scroll container pins outer height to 100dvh and timeline is the scrolling child', async () => {
    await renderPage();
    const outer = screen.getByTestId('recording-detail-page');
    const timeline = screen.getByTestId('recording-timeline');
    // happy-dom drops the `dvh` unit when writing to CSSStyleDeclaration,
    // so the component also stamps a `data-height` attribute as a visible
    // marker of its scroll-pinning intent (L4.4).
    expect(outer.getAttribute('data-height')).toBe('100dvh');
    expect(outer.style.overflow).toBe('hidden');
    expect(timeline.style.overflow).toBe('auto');
  });

  it('renders a collapsed tool_call row with name + tokens', async () => {
    await renderPage();
    const row = screen.getByTestId('tool-row-span-read');
    expect(row.textContent).toContain('Read');
    expect(row.textContent).toContain('1,242');
  });

  it('expands a tool row to show inputs on click', async () => {
    await renderPage();
    const toggle = screen.getByTestId('tool-row-toggle-span-read');
    expect(screen.queryByTestId('tool-row-body-span-read')).toBeNull();
    act(() => {
      fireEvent.click(toggle);
    });
    const body = screen.getByTestId('tool-row-body-span-read');
    expect(body.textContent).toContain('/tmp/CLAUDE.md');
  });

  it('hides lifecycle noise by default and surfaces it via toggle', async () => {
    await renderPage();
    expect(screen.queryByTestId('tool-row-span-bridge')).toBeNull();
    const chip = screen.getByTestId('lifecycle-toggle');
    act(() => {
      fireEvent.click(chip);
    });
    await waitFor(() => expect(screen.getByTestId('tool-row-span-bridge')).toBeTruthy());
  });

  it('renders a subagent group with nested children', async () => {
    await renderPage();
    const group = screen.getByTestId('subagent-group-span-sub');
    expect(group.textContent).toContain('agent-123');
    expect(group.textContent).toContain('scan the repo');
    const inside = within(group);
    expect(inside.getByTestId('tool-row-span-sub-child-1')).toBeTruthy();
    expect(inside.getByTestId('tool-row-span-sub-child-2')).toBeTruthy();
  });
});
