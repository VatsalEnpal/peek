import type { ReactElement } from 'react';
/**
 * Mode B — FocusBar. Renders at the top of the timeline when a focus range
 * is active. Shows event count + token total across the range and exposes
 * Save-as-bookmark / Clear.
 */

import { useMemo } from 'react';

import { useSelectionStore, inFocusRange } from '../stores/selection';
import { useSessionStore, type LedgerEvent, type SpanEvent } from '../stores/session';
import { useBookmarksStore } from '../stores/bookmarks';
import { createBookmark } from '../lib/api';
import { formatTokens } from '../lib/format';

export function FocusBar(): ReactElement | null {
  const focus = useSelectionStore((s) => s.focusRange);
  const clearFocus = useSelectionStore((s) => s.clearFocus);
  const events = useSessionStore((s) => s.events);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const invalidate = useBookmarksStore((s) => s.invalidate);

  const { spanCount, tokenTotal } = useMemo(() => {
    let spanCount = 0;
    let tokenTotal = 0;
    for (const e of events) {
      if (e.kind === 'span') {
        const s = e as SpanEvent;
        if (inFocusRange(s.startTs, focus)) spanCount++;
      } else {
        const l = e as LedgerEvent;
        if (inFocusRange(l.ts, focus)) tokenTotal += l.tokens ?? 0;
      }
    }
    return { spanCount, tokenTotal };
  }, [events, focus]);

  if (!focus.startTs && !focus.endTs) return null;

  const onSave = async (): Promise<void> => {
    if (!selectedSessionId) return;
    const label = typeof window !== 'undefined' ? window.prompt('Bookmark label:', '') : '';
    if (label === null) return; // user cancelled
    try {
      const payload: Parameters<typeof createBookmark>[0] = {
        sessionId: selectedSessionId,
        label: label.trim() || 'focus',
        source: 'focus',
      };
      if (focus.startTs) payload.startTs = focus.startTs;
      if (focus.endTs) payload.endTs = focus.endTs;
      await createBookmark(payload);
      invalidate(selectedSessionId);
      clearFocus();
    } catch {
      /* swallow — the button will simply not clear on error */
    }
  };

  return (
    <div
      data-testid="focus-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--peek-sp-3)',
        padding: '6px 14px',
        background: 'linear-gradient(180deg, rgba(255,180,84,0.08) 0%, rgba(255,180,84,0.02) 100%)',
        borderTop: '1px solid var(--peek-border)',
        borderBottom: '1px solid var(--peek-border)',
        borderLeft: '2px solid var(--peek-accent)',
      }}
    >
      <span
        className="peek-mono"
        style={{
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--peek-accent)',
        }}
      >
        focus
      </span>
      <span
        className="peek-mono"
        style={{ fontSize: 'var(--peek-fs-sm)', color: 'var(--peek-fg)' }}
      >
        {spanCount} event{spanCount === 1 ? '' : 's'}
      </span>
      <span style={{ color: 'var(--peek-fg-faint)' }}>·</span>
      <span
        className="peek-num"
        style={{ fontSize: 'var(--peek-fs-sm)', color: 'var(--peek-fg-dim)' }}
      >
        {formatTokens(tokenTotal)} tokens
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-testid="focus-save"
          onClick={(): void => {
            void onSave();
          }}
          className="peek-mono"
          style={{
            fontSize: 'var(--peek-fs-xs)',
            padding: '3px 10px',
            border: '1px solid var(--peek-accent)',
            color: 'var(--peek-accent)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          save as bookmark
        </button>
        <button
          type="button"
          data-testid="focus-clear"
          onClick={clearFocus}
          className="peek-mono"
          style={{
            fontSize: 'var(--peek-fs-xs)',
            padding: '3px 10px',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          clear
        </button>
      </div>
    </div>
  );
}
