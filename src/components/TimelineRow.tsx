import type { ReactElement } from 'react';
/**
 * Single flat-DOM row in the timeline.
 * Layout: [ts] [icon] [name] [tokens mono right] [▶ if cascade]
 *
 * Right-click opens a small context menu for focus range + save-as-bookmark.
 * Rows out of focus range render dimmed via `style.opacity`.
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
  onSelect: () => void;
  onToggleExpand: () => void;
};

export function TimelineRow({
  span,
  depth,
  hasChildren,
  expanded,
  selected,
  tokens,
  inRange,
  onSelect,
  onToggleExpand,
}: Props): ReactElement {
  // `expanded` is retained on the Props contract for the future Option B
  // cascade UI; currently unused under Option A (children render flat).
  void expanded;
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
        style={{
          display: 'grid',
          gridTemplateColumns: '84px 20px 1fr auto 20px',
          alignItems: 'center',
          gap: 'var(--peek-sp-3)',
          width: '100%',
          padding: '4px 12px',
          paddingLeft: `calc(12px + ${depth * 2}ch)`,
          textAlign: 'left',
          borderLeft: `2px solid ${selected ? 'var(--peek-accent)' : 'transparent'}`,
          background: selected ? 'var(--peek-surface-2)' : 'transparent',
          color: 'var(--peek-fg)',
          fontFamily: 'var(--peek-font-sans)',
          fontSize: 'var(--peek-fs-md)',
          lineHeight: '20px',
        }}
        onMouseEnter={(e): void => {
          if (!selected) e.currentTarget.style.background = 'var(--peek-surface)';
        }}
        onMouseLeave={(e): void => {
          if (!selected) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span
          className="peek-mono"
          style={{ color: 'var(--peek-fg-faint)', fontSize: 'var(--peek-fs-xs)' }}
        >
          {formatClock(span.startTs)}
        </span>
        <span aria-hidden="true" style={{ fontSize: 14, lineHeight: '20px' }}>
          {iconFor(span.type)}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {truncate(name, 120)}
        </span>
        <span
          className="peek-num"
          style={{
            // Muted when missing; amber accent when numeric (labels muted,
            // numbers prominent — see design principles).
            color: tokens === null ? 'var(--peek-fg-faint)' : 'var(--peek-accent)',
            fontSize: 'var(--peek-fs-sm)',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            minWidth: 64,
          }}
        >
          {tokens === null ? '—' : formatTokens(tokens)}
        </span>
        {hasChildren ? (
          <span
            // v0.2 Option A: children already render flat-indented in the
            // stream. The marker is a purely visual parent/group indicator;
            // clicking is a no-op (the underlying row-click still selects).
            // Keep data-testid + onClick wiring so future Option B can swap
            // in a real expand toggle without churn.
            aria-label="group"
            data-testid="cascade-toggle"
            onClick={(e): void => {
              e.stopPropagation();
              onToggleExpand();
            }}
            style={{
              color: 'var(--peek-fg-faint)',
              fontSize: 'var(--peek-fs-xs)',
              display: 'inline-block',
              textAlign: 'center',
              width: 16,
              cursor: 'default',
            }}
          >
            ▸
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
            left: 'calc(12px + 84px)',
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
