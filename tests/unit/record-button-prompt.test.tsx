// @vitest-environment happy-dom
/**
 * L3.5 focused unit tests for `<RecordButton />`.
 *
 * Scope — only the concerns added in L3.5:
 *   1. Clicking the button opens an inline label prompt (not a POST).
 *   2. The prompt's input is pre-filled with the most-recent user_prompt span
 *      name (truncated, whitespace-collapsed) so power users accept with Enter.
 *   3. Submitting the prompt calls `/api/bookmarks` POST with
 *      `{ sessionId, label, source: "record", spanId?, startTs? }`.
 *   4. The `lastUserPromptLabel` helper is a pure function (no React) — easy
 *      regression target.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RecordButton, lastUserPromptLabel } from '../../src/components/RecordButton';
import { useRecordingStore } from '../../src/stores/recording';
import { useSessionStore, type StoreEvent } from '../../src/stores/session';

const EVENTS: StoreEvent[] = [
  {
    kind: 'span',
    id: 'sp-old-prompt',
    sessionId: 'sess-1',
    type: 'user_prompt',
    name: 'first prompt',
    startTs: '2026-04-19T12:00:00Z',
  },
  {
    kind: 'span',
    id: 'sp-tool',
    sessionId: 'sess-1',
    type: 'tool_call',
    name: 'Read something',
    startTs: '2026-04-19T12:00:30Z',
  },
  {
    kind: 'span',
    id: 'sp-latest-prompt',
    sessionId: 'sess-1',
    type: 'user_prompt',
    name: '   do   the\nthing   ',
    startTs: '2026-04-19T12:01:00Z',
  },
];

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let postedBody: Record<string, unknown> | null = null;

function installFetchStub(): void {
  postedBody = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/bookmarks') && method === 'POST') {
        postedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonRes({ id: 'bm-new', ...postedBody }, 201);
      }
      return new Response('{}', { status: 404 });
    })
  );
}

beforeEach(() => {
  installFetchStub();
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    selectedSessionId: 'sess-1',
    events: EVENTS,
    eventsLoading: false,
    eventsError: null,
  });
  useRecordingStore.setState({
    isRecording: false,
    currentBookmarkId: null,
    startTs: null,
    label: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('lastUserPromptLabel (pure)', () => {
  it('returns the most-recent user_prompt name, whitespace-collapsed', () => {
    expect(lastUserPromptLabel(EVENTS)).toBe('do the thing');
  });

  it('returns "" when no user_prompt spans exist', () => {
    expect(
      lastUserPromptLabel([
        { kind: 'span', type: 'tool_call', name: 'Read', id: 'x' },
      ] as unknown as typeof EVENTS)
    ).toBe('');
  });

  it('clamps pathologically-long prompts to a sane length (<= 120 chars)', () => {
    const huge = 'x'.repeat(2000);
    const result = lastUserPromptLabel([
      { kind: 'span', type: 'user_prompt', name: huge, id: 'y' },
    ] as unknown as typeof EVENTS);
    expect(result.length).toBeLessThanOrEqual(120);
  });
});

describe('RecordButton label prompt (L3.5)', () => {
  it('clicking rec opens an inline prompt pre-filled with the last user_prompt', async () => {
    render(<RecordButton />);
    const btn = screen.getByTestId('record-button');
    expect(btn.textContent?.toLowerCase()).toMatch(/rec/);
    // Nothing posted yet.
    expect(postedBody).toBeNull();

    await act(async () => {
      fireEvent.click(btn);
    });

    const input = (await screen.findByTestId('record-label-input')) as HTMLInputElement;
    expect(input.value).toBe('do the thing');
    // Still no POST.
    expect(postedBody).toBeNull();
  });

  it('submitting the prompt POSTs /api/bookmarks with source=record and the edited label', async () => {
    render(<RecordButton />);
    const btn = screen.getByTestId('record-button');

    await act(async () => {
      fireEvent.click(btn);
    });
    const input = (await screen.findByTestId('record-label-input')) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'bug-repro' } });
    });
    const submit = screen.getByTestId('record-label-submit');
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => {
      expect(postedBody).not.toBeNull();
    });
    expect(postedBody!.sessionId).toBe('sess-1');
    expect(postedBody!.source).toBe('record');
    expect(postedBody!.label).toBe('bug-repro');
    expect(typeof postedBody!.startTs).toBe('string');
    // Most-recent span (sp-latest-prompt) should be the anchor.
    expect(postedBody!.spanId).toBe('sp-latest-prompt');
    expect(useRecordingStore.getState().isRecording).toBe(true);
  });

  it('Enter in the input submits; Escape cancels without posting', async () => {
    render(<RecordButton />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-button'));
    });
    const input = await screen.findByTestId('record-label-input');
    // Escape → prompt closes, no POST.
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(screen.queryByTestId('record-label-input')).toBeNull();
    expect(postedBody).toBeNull();

    // Reopen and test Enter.
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-button'));
    });
    const input2 = await screen.findByTestId('record-label-input');
    await act(async () => {
      fireEvent.change(input2, { target: { value: 'enter-submit' } });
      fireEvent.keyDown(input2, { key: 'Enter' });
    });
    await waitFor(() => {
      expect(postedBody).not.toBeNull();
    });
    expect(postedBody!.label).toBe('enter-submit');
  });
});
