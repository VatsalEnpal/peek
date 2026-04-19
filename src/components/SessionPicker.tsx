import type { ReactElement } from 'react';
/**
 * Session picker with nested bookmarks sub-picker (Mode C).
 *
 * The native <select> remains as the primary switch so screen readers and
 * keyboard users are unaffected; the bookmark sub-picker renders as an
 * inline, per-session disclosure below the select.
 */

import { useEffect, useState } from 'react';

import { useSessionStore } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { useBookmarksStore } from '../stores/bookmarks';
import { truncate } from '../lib/format';
import type { BookmarkDto } from '../lib/api';

function sourceIcon(source: string | undefined): string {
  if (source === 'record') return '●';
  if (source === 'focus') return '◎';
  if (source === 'marker') return '⚓';
  return '·';
}

export function SessionPicker(): ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const loading = useSessionStore((s) => s.sessionsLoading);
  const error = useSessionStore((s) => s.sessionsError);
  const selectSession = useSessionStore((s) => s.selectSession);

  const bySession = useBookmarksStore((s) => s.bySession);
  const fetchForSession = useBookmarksStore((s) => s.fetchForSession);
  const setFocusStart = useSelectionStore((s) => s.setFocusStart);
  const setFocusEnd = useSelectionStore((s) => s.setFocusEnd);
  const clearFocus = useSelectionStore((s) => s.clearFocus);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (sessionId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        void fetchForSession(sessionId);
      }
      return next;
    });
  };

  // Prefetch bookmarks for the currently-selected session so clicking "expand"
  // shows results immediately.
  useEffect(() => {
    if (selectedId) void fetchForSession(selectedId);
  }, [selectedId, fetchForSession]);

  const onSelectBookmark = (bm: BookmarkDto): void => {
    void selectSession(bm.sessionId);
    clearFocus();
    if (bm.startTs) setFocusStart(bm.startTs);
    if (bm.endTs) setFocusEnd(bm.endTs);
  };

  return (
    <div
      data-testid="session-picker-root"
      style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}
    >
      <label
        data-testid="session-picker"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--peek-sp-2)',
          fontSize: 'var(--peek-fs-sm)',
          color: 'var(--peek-fg-dim)',
        }}
      >
        <span
          className="peek-mono"
          style={{ fontSize: 'var(--peek-fs-xs)', letterSpacing: '0.08em' }}
        >
          SESSION
        </span>
        <select
          value={selectedId ?? ''}
          disabled={loading || sessions.length === 0}
          onChange={(e): void => {
            const id = e.target.value || null;
            void selectSession(id);
          }}
          style={{
            background: 'var(--peek-surface-2)',
            color: 'var(--peek-fg)',
            border: '1px solid var(--peek-border)',
            padding: '4px 8px',
            fontFamily: 'var(--peek-font-mono)',
            fontSize: 'var(--peek-fs-sm)',
            minWidth: 280,
            maxWidth: 520,
          }}
        >
          {sessions.length === 0 && (
            <option value="">{loading ? 'loading…' : 'no sessions'}</option>
          )}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {truncate(s.label, 60)} · {s.timeAgo}
            </option>
          ))}
        </select>
        {error !== null && (
          <span style={{ color: 'var(--peek-bad)', fontSize: 'var(--peek-fs-xs)' }}>
            {truncate(error, 40)}
          </span>
        )}
      </label>

      {sessions.length > 0 && (
        <ul
          data-testid="session-list"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {sessions.map((s) => {
            const isOpen = expanded.has(s.id);
            const bookmarks = bySession[s.id] ?? [];
            const isSelected = selectedId === s.id;
            return (
              <li key={s.id} data-testid={`session-row-${s.id}`}>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 'var(--peek-fs-xs)',
                  }}
                >
                  <button
                    type="button"
                    data-testid={`session-expand-${s.id}`}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'collapse bookmarks' : 'expand bookmarks'}
                    onClick={(): void => toggleExpand(s.id)}
                    className="peek-mono"
                    style={{
                      width: 18,
                      height: 18,
                      padding: 0,
                      background: 'transparent',
                      border: '1px solid var(--peek-border)',
                      color: 'var(--peek-fg-dim)',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 80ms ease-out',
                    }}
                  >
                    ▶
                  </button>
                  {/*
                    Checker BLOCKING: `<select><option>` traps e2e-script clicks.
                    Render each session label as a real button so any click
                    target (including plain `click()`) navigates to detail.
                  */}
                  <button
                    type="button"
                    data-testid={`session-select-${s.id}`}
                    aria-pressed={isSelected}
                    onClick={(): void => {
                      void selectSession(s.id);
                    }}
                    className="peek-mono"
                    style={{
                      background: 'transparent',
                      border: '1px solid transparent',
                      padding: '1px 4px',
                      color: isSelected ? 'var(--peek-accent)' : 'var(--peek-fg-dim)',
                      letterSpacing: '0.04em',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: 'var(--peek-fs-xs)',
                      borderLeft: isSelected
                        ? '2px solid var(--peek-accent)'
                        : '2px solid transparent',
                    }}
                  >
                    {truncate(s.label, 40)}
                  </button>
                </div>
                {isOpen && (
                  <ul
                    data-testid={`bookmarks-${s.id}`}
                    style={{
                      listStyle: 'none',
                      margin: '2px 0 2px 24px',
                      padding: 0,
                    }}
                  >
                    {bookmarks.length === 0 && (
                      <li
                        style={{
                          fontSize: 'var(--peek-fs-xs)',
                          color: 'var(--peek-fg-faint)',
                          padding: '2px 4px',
                        }}
                      >
                        no bookmarks
                      </li>
                    )}
                    {bookmarks.map((bm) => (
                      <li key={bm.id}>
                        <button
                          type="button"
                          data-testid={`bookmark-${bm.id}`}
                          onClick={(): void => onSelectBookmark(bm)}
                          className="peek-mono"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '2px 6px',
                            border: '1px solid transparent',
                            background: 'transparent',
                            color: 'var(--peek-fg-dim)',
                            fontSize: 'var(--peek-fs-xs)',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <span aria-hidden="true">{sourceIcon(bm.source)}</span>
                          <span>{truncate(bm.label ?? bm.id, 60)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
