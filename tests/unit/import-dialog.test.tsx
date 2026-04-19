// @vitest-environment happy-dom
/**
 * L2.3 — ImportDialog wizard polish.
 *
 * Coverage matrix:
 *   - Auto-runs preview when the dialog opens.
 *   - Renders a checkbox per discovered session; all checked by default.
 *   - "Select all" toggle flips to "Select none" once everything is selected.
 *   - "Import N sessions" label updates live with the selection count.
 *   - Import button is disabled when nothing is selected.
 *   - Clicking Import fires `POST /api/import/commit`.
 *   - A server error renders as an inline banner.
 *   - formatBytes / formatAgo are pure & correct.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  ImportDialog,
  formatBytes,
  formatAgo,
  previewLabel,
} from '../../src/components/ImportDialog';
import { useSessionStore } from '../../src/stores/session';

// ---------------------------------------------------------------------------
// Fetch stubbing — we want to observe preview + commit calls.
// ---------------------------------------------------------------------------

type FetchRecord = { url: string; body: unknown };

function installFetchStub(): {
  calls: FetchRecord[];
  respond: (url: RegExp, body: unknown, status?: number) => void;
  restore: () => void;
} {
  const calls: FetchRecord[] = [];
  const handlers: Array<{ url: RegExp; body: unknown; status: number }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    let parsedBody: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, body: parsedBody });
    const handler = handlers.find((h) => h.url.test(url));
    if (!handler) {
      return new Response(JSON.stringify({ error: 'no handler' }), { status: 500 });
    }
    return new Response(JSON.stringify(handler.body), {
      status: handler.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    respond(url, body, status = 200) {
      handlers.push({ url, body, status });
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

const PREVIEW_BODY = {
  sessions: [
    {
      id: 'sess-aaaa',
      label: 'alpha session',
      slug: 'alpha-slug',
      sizeBytes: 2048,
      mtime: new Date().toISOString(),
      turnCount: 5,
      totalTokens: 1234,
    },
    {
      id: 'sess-bbbb',
      label: 'beta session',
      slug: 'beta-slug',
      sizeBytes: 4096,
      mtime: new Date(Date.now() - 3600_000).toISOString(),
      turnCount: 12,
      totalTokens: 5678,
    },
  ],
  driftWarnings: [],
};

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    fetchSessions: async (): Promise<void> => {
      /* no-op in tests */
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ImportDialog (L2.3)', () => {
  describe('format helpers', () => {
    it('formatBytes renders MB / KB / B with a single decimal', () => {
      expect(formatBytes(null)).toBe('—');
      expect(formatBytes(undefined)).toBe('—');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(2048)).toBe('2.0 KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('formatAgo renders relative time', () => {
      const now = Date.now();
      const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();
      expect(formatAgo(thirtyMinAgo, now)).toBe('30m ago');
      expect(formatAgo(null)).toBe('—');
    });

    it('previewLabel prefers slug, then label, then id[:8]', () => {
      expect(
        previewLabel({ id: 'x', label: 'lbl', slug: 'slug-abc', turnCount: 0, totalTokens: 0 })
      ).toBe('slug-abc');
      expect(previewLabel({ id: 'x', label: 'the-label', turnCount: 0, totalTokens: 0 })).toBe(
        'the-label'
      );
      expect(
        previewLabel({
          id: 'abcd1234deadbeef',
          label: '',
          slug: null,
          turnCount: 0,
          totalTokens: 0,
        })
      ).toBe('abcd1234');
    });
  });

  it('auto-runs preview on open and renders a checkbox per session', async () => {
    const stub = installFetchStub();
    stub.respond(/\/api\/import\/preview/, PREVIEW_BODY);

    render(<ImportDialog open onClose={(): void => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('import-checkbox-sess-aaaa')).toBeDefined();
    });
    expect(screen.getByTestId('import-checkbox-sess-bbbb')).toBeDefined();

    // Both checkboxes start checked (default = everything selected).
    const cb1 = screen.getByTestId('import-checkbox-sess-aaaa') as HTMLInputElement;
    const cb2 = screen.getByTestId('import-checkbox-sess-bbbb') as HTMLInputElement;
    expect(cb1.checked).toBe(true);
    expect(cb2.checked).toBe(true);

    // preview endpoint was called exactly once.
    const previewCalls = stub.calls.filter((c) => /import\/preview/.test(c.url));
    expect(previewCalls.length).toBe(1);

    stub.restore();
  });

  it('"Import N sessions" label updates as selection changes and disables at 0', async () => {
    const stub = installFetchStub();
    stub.respond(/\/api\/import\/preview/, PREVIEW_BODY);

    render(<ImportDialog open onClose={(): void => {}} />);

    await waitFor(() => screen.getByTestId('import-checkbox-sess-aaaa'));

    const commit = screen.getByTestId('import-commit-btn') as HTMLButtonElement;
    // 2 selected by default.
    expect(commit.textContent?.toLowerCase()).toContain('2');
    expect(commit.disabled).toBe(false);

    // Uncheck one — label shows "1 session"
    fireEvent.click(screen.getByTestId('import-checkbox-sess-aaaa'));
    await waitFor(() => {
      expect(commit.textContent?.toLowerCase()).toContain('1 session');
    });

    // Uncheck the other — button disabled.
    fireEvent.click(screen.getByTestId('import-checkbox-sess-bbbb'));
    await waitFor(() => {
      expect(commit.disabled).toBe(true);
    });

    stub.restore();
  });

  it('"Select all" toggles to "Select none" and back', async () => {
    const stub = installFetchStub();
    stub.respond(/\/api\/import\/preview/, PREVIEW_BODY);

    render(<ImportDialog open onClose={(): void => {}} />);
    await waitFor(() => screen.getByTestId('import-select-all'));

    // Initially everything is selected → label says "select none"
    const btn = screen.getByTestId('import-select-all');
    expect(btn.textContent?.toLowerCase()).toContain('none');

    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn.textContent?.toLowerCase()).toContain('all');
    });

    // Everything unchecked.
    const cb1 = screen.getByTestId('import-checkbox-sess-aaaa') as HTMLInputElement;
    expect(cb1.checked).toBe(false);

    stub.restore();
  });

  it('clicking Import hits /api/import/commit and closes on success', async () => {
    const stub = installFetchStub();
    stub.respond(/\/api\/import\/preview/, PREVIEW_BODY);
    stub.respond(/\/api\/import\/commit/, { sessions: PREVIEW_BODY.sessions });

    const onClose = vi.fn();
    render(<ImportDialog open onClose={onClose} />);
    await waitFor(() => screen.getByTestId('import-commit-btn'));

    fireEvent.click(screen.getByTestId('import-commit-btn'));

    await waitFor(() => {
      expect(stub.calls.some((c) => /import\/commit/.test(c.url))).toBe(true);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });

    stub.restore();
  });

  it('renders an error banner when the server errors', async () => {
    const stub = installFetchStub();
    stub.respond(/\/api\/import\/preview/, { error: 'boom', message: 'path not found' }, 500);

    render(<ImportDialog open onClose={(): void => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId('import-error')).toBeDefined();
    });
    expect(screen.getByTestId('import-error').textContent?.toLowerCase()).toContain('failed');

    stub.restore();
  });
});
