import type { ReactElement } from 'react';
/**
 * Toggleable filter chips driving `useSessionStore.activeChips`.
 *
 * Accessibility:
 *   - Each chip renders as a native `<button>` so Enter / Space toggle for
 *     free and the global `button:focus-visible` outline applies.
 *   - `aria-pressed` reports toggle state to assistive tech.
 *   - `aria-label` spells out the current state ("Filter: prompts (active)").
 */

import { useSessionStore, type ChipKey } from '../stores/session';
import { CHIP_DEFS } from '../lib/icons';

export function FilterChips(): ReactElement {
  const active = useSessionStore((s) => s.activeChips);
  const toggle = useSessionStore((s) => s.toggleChip);

  return (
    <div
      data-testid="filter-chips"
      role="group"
      aria-label="timeline filters"
      style={{ display: 'inline-flex', gap: 'var(--peek-sp-1)', flexWrap: 'wrap' }}
    >
      {CHIP_DEFS.map((def) => {
        const on = active.has(def.key as ChipKey);
        return (
          <button
            key={def.key}
            type="button"
            aria-pressed={on}
            aria-label={`Filter: ${def.label} (${on ? 'active' : 'inactive'})`}
            data-testid={`chip-${def.key}`}
            onClick={(): void => toggle(def.key as ChipKey)}
            className="peek-mono"
            style={{
              fontSize: 'var(--peek-fs-xs)',
              padding: '3px 8px',
              border: `1px solid ${on ? 'var(--peek-accent)' : 'var(--peek-border)'}`,
              color: on ? 'var(--peek-accent)' : 'var(--peek-fg-dim)',
              background: on ? 'rgba(255,180,84,0.08)' : 'transparent',
              letterSpacing: '0.04em',
              cursor: 'pointer',
            }}
          >
            {def.label}
          </button>
        );
      })}
    </div>
  );
}
