// @vitest-environment happy-dom
/**
 * BUG-6 regression: reopening the same span after closing the drawer must not
 * leak plaintext from a previously-unmasked ledger entry.
 *
 * The drawer is a CSS-transform slide — the Inspector DOM subtree doesn't
 * unmount on close, so `UnmaskButton` keeps its local `revealed=true` and
 * `plaintextRef.current`. Closing + reselecting the same row used to show the
 * plaintext again without any user gesture.
 *
 * Fix: UnmaskButton subscribes to `drawerOpen` and resets local state when the
 * drawer closes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Inspector } from '../../src/components/Inspector';
import { useSessionStore, type StoreEvent } from '../../src/stores/session';
import { useSelectionStore } from '../../src/stores/selection';

const SPAN_ID = 'span-bug6';
const LEDGER_ID = 'ledger-bug6';
const REDACTED = '<secret:abcdef01>';
const PLAINTEXT = 'sk-ant-api03-TEST-SECRET-xyz';

const EVENTS: StoreEvent[] = [
  {
    kind: 'span',
    id: SPAN_ID,
    sessionId: 'sess-bug6',
    type: 'tool',
    name: 'leaky tool call',
    startTs: '2026-04-19T12:00:00Z',
    durationMs: 10,
  },
  {
    kind: 'ledger',
    id: LEDGER_ID,
    sessionId: 'sess-bug6',
    introducedBySpanId: SPAN_ID,
    source: 'tool',
    tokens: 42,
    contentRedacted: REDACTED,
    ts: '2026-04-19T12:00:00Z',
  },
];

function installFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/unmask') && method === 'POST') {
        return new Response(
          JSON.stringify({
            ledgerEntryId: LEDGER_ID,
            sessionId: 'sess-bug6',
            plaintext: PLAINTEXT,
            sourceFile: '/tmp/fake.jsonl',
            byteStart: 0,
            byteEnd: PLAINTEXT.length,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    })
  );
}

function resetStores(): void {
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: 'sess-bug6',
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

beforeEach(() => {
  installFetchStub();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('UnmaskButton lifecycle on drawer close/reopen (BUG-6)', () => {
  it('re-masks plaintext when drawer closes and the same span is reopened', async () => {
    render(<Inspector />);

    // Open the drawer on the span with the redacted ledger entry.
    act(() => {
      useSelectionStore.getState().selectSpan(SPAN_ID);
    });

    // Expand the `context ledger` <details> so the UnmaskButton is reachable.
    await waitFor(() => {
      expect(screen.getByTestId('inspector-name').textContent).toContain('leaky tool call');
    });
    const ledgerSummary = Array.from(document.querySelectorAll('details > summary')).find((el) =>
      (el.textContent ?? '').toLowerCase().includes('context ledger')
    );
    expect(ledgerSummary).toBeTruthy();
    act(() => {
      fireEvent.click(ledgerSummary as Element);
    });

    // Initial state: redacted text visible, unmask button offered.
    const textBefore = await screen.findByTestId('unmask-text');
    expect(textBefore.textContent).toContain(REDACTED);
    const btn = screen.getByRole('button', { name: /unmask/i });
    expect(btn.textContent?.toLowerCase()).toContain('unmask');

    // Click unmask → plaintext appears.
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByTestId('unmask-text').textContent).toContain(PLAINTEXT);
    });
    expect(screen.getByRole('button', { name: /mask/i }).textContent?.toLowerCase()).toContain(
      'mask'
    );

    // Close the drawer (CSS slide-out — Inspector subtree stays mounted).
    act(() => {
      useSelectionStore.getState().closeDrawer();
    });

    // Reopen the SAME span. Bug repro: plaintext re-appears without consent.
    act(() => {
      useSelectionStore.getState().selectSpan(SPAN_ID);
    });

    // Re-expand ledger section in case <details> collapsed.
    await waitFor(() => {
      expect(screen.getByTestId('inspector-name').textContent).toContain('leaky tool call');
    });
    const ledgerSummary2 = Array.from(document.querySelectorAll('details > summary')).find((el) =>
      (el.textContent ?? '').toLowerCase().includes('context ledger')
    );
    if (ledgerSummary2 && !(ledgerSummary2.parentElement as HTMLDetailsElement | null)?.open) {
      act(() => {
        fireEvent.click(ledgerSummary2 as Element);
      });
    }

    const textAfter = await screen.findByTestId('unmask-text');
    expect(textAfter.textContent ?? '').not.toContain('sk-ant-api03-TEST-SECRET-');
    expect(textAfter.textContent ?? '').toMatch(/<secret:[a-f0-9]+>/);

    const btnAfter = screen.getByRole('button', { name: /unmask/i });
    expect(btnAfter.textContent?.toLowerCase()).toContain('unmask');
    expect(btnAfter.textContent?.toLowerCase()).not.toContain('🔒 mask');
  });
});
