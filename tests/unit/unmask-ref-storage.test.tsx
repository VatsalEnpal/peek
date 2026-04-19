// @vitest-environment happy-dom
/**
 * L4.4 — prove that unmask plaintext never enters any Zustand store and that
 * closing the drawer clears the ref-backed plaintext (subsequent re-open
 * shows the redacted token again, not the unmasked string).
 *
 * The mechanism: `UnmaskButton` holds a `useRef<string | null>(null)` and
 * writes `resp.plaintext` into `.current`. It subscribes to `drawerOpen` and
 * resets the ref on close (BUG-6 fix, kept here as a regression).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UnmaskButton } from '../../src/components/UnmaskButton';
import { useSessionStore } from '../../src/stores/session';
import { useSelectionStore } from '../../src/stores/selection';

const LEDGER_ID = 'ledger-refcheck';
const REDACTED = '<secret:refcheck>';
const PLAINTEXT = 'sk-ant-api03-REF-CHECK-ABC';

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
            sessionId: 'sess',
            plaintext: PLAINTEXT,
            sourceFile: '/tmp/fake.jsonl',
            byteStart: 0,
            byteEnd: PLAINTEXT.length,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    })
  );
}

beforeEach(() => {
  installFetchStub();
  useSelectionStore.setState({
    selectedSpanId: 'span-1',
    drawerOpen: true,
    helpOpen: false,
    focusRange: {},
    contextMenuRowId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('L4.4 — plaintext is stored in a useRef, not in any store', () => {
  it('unmasked plaintext never appears in zustand state', async () => {
    render(<UnmaskButton ledgerEntryId={LEDGER_ID} redacted={REDACTED} />);

    const btn = screen.getByRole('button', { name: /unmask/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByTestId('unmask-text').textContent).toContain(PLAINTEXT);
    });

    // Serialise every store we have. The plaintext must not be present.
    const selectionJson = JSON.stringify(useSelectionStore.getState());
    const sessionJson = JSON.stringify(useSessionStore.getState());
    expect(selectionJson).not.toContain('sk-ant-api03-REF-CHECK');
    expect(selectionJson).not.toContain(PLAINTEXT);
    expect(sessionJson).not.toContain(PLAINTEXT);
  });

  it('closing the drawer clears the ref and re-shows the redacted token', async () => {
    render(<UnmaskButton ledgerEntryId={LEDGER_ID} redacted={REDACTED} />);

    // Reveal the plaintext.
    const btn = screen.getByRole('button', { name: /unmask/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByTestId('unmask-text').textContent).toContain(PLAINTEXT);
    });

    // Close the drawer (simulates URL-sync driven close).
    act(() => {
      useSelectionStore.getState().closeDrawer();
    });

    // The visible text should revert to the redacted token; the re-render
    // pulls from the now-null ref, so no plaintext leaks into the DOM.
    await waitFor(() => {
      const txt = screen.getByTestId('unmask-text').textContent ?? '';
      expect(txt).not.toContain(PLAINTEXT);
      expect(txt).toContain(REDACTED);
    });
  });
});
