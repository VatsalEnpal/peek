import type { ReactElement } from 'react';
/**
 * Single flat-DOM row in the timeline.
 * Layout: [ts] [icon] [name] [tokens mono right] [▶ if cascade]
 */

import type { SpanEvent } from '../stores/session';
import { formatClock, formatTokens, truncate } from '../lib/format';
import { iconFor } from '../lib/icons';

type Props = {
  span: SpanEvent;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  tokens: number | null;
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
  onSelect,
  onToggleExpand,
}: Props): ReactElement {
  const name = span.name ?? span.type;
  return (
    <button
      type="button"
      data-testid="timeline-row"
      data-span-id={span.id}
      data-span-type={span.type}
      aria-selected={selected}
      onClick={onSelect}
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
          color: tokens === null ? 'var(--peek-fg-faint)' : 'var(--peek-fg-dim)',
          fontSize: 'var(--peek-fs-sm)',
          textAlign: 'right',
          minWidth: 64,
        }}
      >
        {tokens === null ? '—' : formatTokens(tokens)}
      </span>
      {hasChildren ? (
        <span
          role="button"
          aria-label={expanded ? 'collapse' : 'expand'}
          data-testid="cascade-toggle"
          onClick={(e): void => {
            e.stopPropagation();
            onToggleExpand();
          }}
          style={{
            color: 'var(--peek-fg-dim)',
            fontSize: 'var(--peek-fs-xs)',
            transition: 'transform 80ms ease-out',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            display: 'inline-block',
            textAlign: 'center',
            width: 16,
          }}
        >
          ▶
        </span>
      ) : (
        <span />
      )}
    </button>
  );
}
