import type { ReactElement } from 'react';
/**
 * Single row of the L2 timeline.
 *
 * Fixed grid (mockup L2 — L3.2):
 *   ┌──────────┬──────┬─────────┬─────────────┬─────────┬─────┐
 *   │ time     │ icon │ TYPE    │ name        │ tokens  │ ▸   │
 *   │ 96px     │ 20px │ 88px    │ 1fr         │ 96px    │16px │
 *   │ mono     │ emo  │ upper   │ truncate    │ amber   │ arr │
 *   └──────────┴──────┴─────────┴─────────────┴─────────┴─────┘
 *
 * Right-click opens a small context menu for focus range + save-as-bookmark.
 * Rows out of focus range render dimmed via `style.opacity`.
 * Click row → parent handler navigates to `/session/:id/span/:spanId`.
 * Cascade arrow (▸ / ▾) toggles an expansion Set on the session store (L3.4)
 * without regressing the flatten; children render flat whether expanded or not.
 */

import { useEffect, useRef } from 'react';

import type { SpanEvent } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { useSessionStore } from '../stores/session';
import { useBookmarksStore } from '../stores/bookmarks';
import { createBookmark } from '../lib/api';
import { formatClock, formatTokens, truncate } from '../lib/format';
import { iconFor } from '../lib/icons';

type Props = {
  span: SpanEvent;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  tokens: number | null;
  inRange: boolean;
  /**
   * Whether this row is rendered inside a collapsed ancestor group (L3.4).
   * Hidden rows return a zero-height sentinel so keyboard indices still line
   * up with what's visible — but they take no visual space.
   */
  hiddenByCollapse?: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
};

/** Types that carry a name from subagent / api_call → render in serif italic per mockup. */
const SERIF_TYPES = new Set(['subagent', 'api_call', 'user_prompt']);

/** Short, stable label per SpanType for the TYPE column. Falls back to the raw type. */
function typeLabel(type: string): string {
  switch (type) {
    case 'user_prompt':
      return 'prompt';
    case 'api_call':
      return 'api';
    case 'thinking_block':
      return 'think';
    case 'tool_call':
      return 'tool';
    case 'subagent':
      return 'agent';
    case 'skill_activation':
      return 'skill';
    case 'mcp_call':
      return 'mcp';
    case 'memory_read':
      return 'file';
    case 'hook_fire':
      return 'hook';
    default:
      return type.length > 10 ? type.slice(0, 10) : type;
  }
}

export function TimelineRow({
  span,
  depth,
  hasChildren,
  expanded,
  selected,
  tokens,
  inRange,
  hiddenByCollapse,
  onSelect,
  onToggleExpand,
}: Props): ReactElement {
  const name = span.name ?? span.type;
  const contextMenuRowId = useSelectionStore((s) => s.contextMenuRowId);
  const openContextMenu = useSelectionStore((s) => s.openContextMenu);
  const closeContextMenu = useSelectionStore((s) => s.closeContextMenu);
  const setFocusStart = useSelectionStore((s) => s.setFocusStart);
  const setFocusEnd = useSelectionStore((s) => s.setFocusEnd);
  const clearFocus = useSelectionStore((s) => s.clearFocus);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const invalidate = useBookmarksStore((s) => s.invalidate);

  const menuOpen = contextMenuRowId === span.id;
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside-click closer.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) closeContextMenu();
    };
    window.addEventListener('mousedown', onDoc);
    return (): void => window.removeEventListener('mousedown', onDoc);
  }, [menuOpen, closeContextMenu]);

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    openContextMenu(span.id);
  };

  const handleFocusStart = (): void => {
    if (span.startTs) setFocusStart(span.startTs);
    closeContextMenu();
  };
  const handleFocusEnd = (): void => {
    if (span.startTs) setFocusEnd(span.startTs);
    closeContextMenu();
  };
  const handleClearFocus = (): void => {
    clearFocus();
    closeContextMenu();
  };
  const handleSaveBookmark = async (): Promise<void> => {
    closeContextMenu();
    if (!selectedSessionId) return;
    const raw = typeof window !== 'undefined' ? window.prompt('Bookmark label:', name) : '';
    if (raw === null) return;
    const payload: Parameters<typeof createBookmark>[0] = {
      sessionId: selectedSessionId,
      label: raw.trim() || name,
      source: 'focus',
    };
    if (span.startTs) payload.startTs = span.startTs;
    try {
      await createBookmark(payload);
      invalidate(selectedSessionId);
    } catch {
      /* quiet failure — keep velocity */
    }
  };

  if (hiddenByCollapse === true) {
    // Render a zero-height anchor so tests / keyboard nav that walks the DOM
    // can still find the row, while the user sees nothing.
    return (
      <div
        ref={rootRef}
        data-testid="timeline-row"
        data-span-id={span.id}
        data-span-type={span.type}
        data-hidden="true"
        aria-hidden="true"
        style={{ display: 'none' }}
      />
    );
  }

  const useSerif = SERIF_TYPES.has(span.type);
  const indentCh = Math.min(depth, 4) * 3; // 3ch per indent level

  return (
    <div ref={rootRef} style={{ position: 'relative', opacity: inRange ? 1 : 0.4 }}>
      <button
        type="button"
        data-testid="timeline-row"
        data-span-id={span.id}
        data-span-type={span.type}
        aria-selected={selected}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        // L2.2 — newly-mounted rows fade in (300ms). Existing rows are not
        // re-mounted across refetches because they're keyed by span.id, so
        // only spans that genuinely arrived live get the animation.
        className="peek-row-enter"
        style={{
          // L2.8 — fixed grid columns: ts / icon / TYPE / name / tokens / caret.
          // Widths match the morning-review spec so columns line up across rows
          // regardless of content length.
          display: 'grid',
          gridTemplateColumns: '80px 32px 80px 1fr 80px 24px',
          alignItems: 'baseline',
          columnGap: 12,
          width: '100%',
          padding: '6px 24px',
          paddingLeft: `calc(24px + ${indentCh}ch)`,
          textAlign: 'left',
          borderLeft: `2px solid ${selected ? 'var(--peek-accent)' : 'transparent'}`,
          background: selected ? 'rgba(255, 180, 84, 0.08)' : 'transparent',
          color: 'var(--peek-fg)',
          fontFamily: 'var(--peek-font-sans)',
          fontSize: 'var(--peek-fs-md)',
          lineHeight: '20px',
          cursor: 'pointer',
        }}
        onMouseEnter={(e): void => {
          if (!selected) e.currentTarget.style.background = 'var(--peek-surface-2)';
        }}
        onMouseLeave={(e): void => {
          if (!selected) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          className="peek-mono"
          style={{
            color: 'var(--peek-fg-faint)',
            fontSize: 'var(--peek-fs-xs)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatClock(span.startTs)}
        </span>
        <span aria-hidden="true" style={{ fontSize: 13, textAlign: 'center' }}>
          {iconFor(span.type)}
        </span>
        <span
          className="peek-mono"
          style={{
            color: 'var(--peek-fg-dim)',
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          {typeLabel(span.type)}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: useSerif ? '"Fraunces", Georgia, serif' : 'var(--peek-font-sans)',
            fontStyle: useSerif ? 'italic' : 'normal',
            fontSize: useSerif ? 14 : 'var(--peek-fs-md)',
            color: 'var(--peek-fg)',
            letterSpacing: useSerif ? '-0.005em' : 0,
          }}
        >
          {truncate(name, 120)}
        </span>
        <span
          className="peek-num"
          style={{
            color: tokens === null || tokens === 0 ? 'var(--peek-fg-faint)' : 'var(--peek-accent)',
            fontSize: 'var(--peek-fs-sm)',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            fontWeight: tokens !== null && tokens > 0 ? 500 : 400,
          }}
        >
          {tokens === null ? '—' : formatTokens(tokens)}
        </span>
        {hasChildren ? (
          <span
            // L3.4 — cascade arrow. Clicking toggles the expansion Set so the
            // TYPE label/arrow flips between ▸ (collapsed) and ▾ (expanded).
            // Children still render flat either way — collapsed simply hides
            // them in the DOM via the `hiddenByCollapse` prop. Keyboard users
            // can drive the same toggle via h / l in AppShell.
            aria-label={expanded ? 'collapse group' : 'expand group'}
            aria-expanded={expanded}
            role="button"
            tabIndex={0}
            data-testid="cascade-toggle"
            onClick={(e): void => {
              e.stopPropagation();
              onToggleExpand();
            }}
            onKeyDown={(e): void => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onToggleExpand();
              }
            }}
            style={{
              color: expanded ? 'var(--peek-accent)' : 'var(--peek-fg-faint)',
              fontSize: 'var(--peek-fs-xs)',
              display: 'inline-block',
              textAlign: 'center',
              width: 24,
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span />
        )}
      </button>
      {menuOpen && (
        <ul
          data-testid="row-context-menu"
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 'calc(12px + 96px)',
            margin: 0,
            padding: '4px 0',
            listStyle: 'none',
            minWidth: 200,
            background: 'var(--peek-surface-2)',
            border: '1px solid var(--peek-border)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            zIndex: 20,
          }}
        >
          <CtxItem testid="ctx-focus-start" onClick={handleFocusStart}>
            focus from here
          </CtxItem>
          <CtxItem testid="ctx-focus-end" onClick={handleFocusEnd}>
            end focus here
          </CtxItem>
          <CtxItem testid="ctx-focus-clear" onClick={handleClearFocus}>
            clear focus
          </CtxItem>
          <li
            style={{ height: 1, background: 'var(--peek-border)', margin: '4px 0' }}
            aria-hidden="true"
          />
          <CtxItem
            testid="ctx-save-bookmark"
            onClick={(): void => {
              void handleSaveBookmark();
            }}
          >
            save as bookmark…
          </CtxItem>
        </ul>
      )}
    </div>
  );
}

function CtxItem({
  children,
  onClick,
  testid,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testid: string;
}): ReactElement {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        data-testid={testid}
        onClick={onClick}
        className="peek-mono"
        style={{
          display: 'block',
          width: '100%',
          padding: '6px 14px',
          textAlign: 'left',
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--peek-fg-dim)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e): void => {
          e.currentTarget.style.background = 'var(--peek-surface)';
          e.currentTarget.style.color = 'var(--peek-accent)';
        }}
        onMouseLeave={(e): void => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--peek-fg-dim)';
        }}
      >
        {children}
      </button>
    </li>
  );
}
