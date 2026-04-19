import type { ReactElement } from 'react';
/**
 * Toggleable filter chips driving `useSessionStore.activeChips`.
 *
 * Mockup L2 parity:
 *   - 7 chips: prompts, files, skills, hooks, api, tools, subagents.
 *   - Active: amber outline + faint amber fill.
 *   - Inactive: muted border + muted text, no fill.
 *   - Each chip renders a small count badge (sum of spans matching that chip
 *     across the current session's events) so users get a sense of scale.
 *
 * Accessibility:
 *   - Native `<button>`s, `aria-pressed` reports toggle state, `aria-label`
 *     spells out state + count.
 */

import { useMemo } from 'react';

import { useSessionStore, type ChipKey } from '../stores/session';
import { CHIP_DEFS } from '../lib/icons';

export function FilterChips(): ReactElement {
  const active = useSessionStore((s) => s.activeChips);
  const toggle = useSessionStore((s) => s.toggleChip);
  const events = useSessionStore((s) => s.events);

  // Counts per chip — sum of spans whose type matches the chip's `matches`.
  // Recomputed only when events change.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const def of CHIP_DEFS) out[def.key] = 0;
    for (const e of events) {
      if (e.kind !== 'span') continue;
      for (const def of CHIP_DEFS) {
        if (def.matches.includes(e.type)) {
          out[def.key] = (out[def.key] ?? 0) + 1;
          break;
        }
      }
    }
    return out;
  }, [events]);

  return (
    <div
      data-testid="filter-chips"
      role="group"
      aria-label="timeline filters"
      // L2.8 — 8px gap between chips (previously cramped at 6px).
      style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
    >
      {CHIP_DEFS.map((def) => {
        const on = active.has(def.key as ChipKey);
        const count = counts[def.key] ?? 0;
        return (
          <button
            key={def.key}
            type="button"
            aria-pressed={on}
            aria-label={`Filter: ${def.label} (${count}) (${on ? 'active' : 'inactive'})`}
            data-testid={`chip-${def.key}`}
            data-chip-count={count}
            onClick={(): void => toggle(def.key as ChipKey)}
            className="peek-mono"
            style={{
              fontSize: 'var(--peek-fs-xs)',
              padding: '3px 10px',
              border: `1px solid ${on ? 'var(--peek-accent)' : 'var(--peek-border)'}`,
              color: on ? 'var(--peek-accent)' : 'var(--peek-fg-dim)',
              background: on ? 'rgba(255, 180, 84, 0.08)' : 'transparent',
              letterSpacing: '0.04em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span>{def.label}</span>
            {count > 0 && (
              <span
                data-testid={`chip-count-${def.key}`}
                style={{
                  color: on ? 'var(--peek-accent)' : 'var(--peek-fg-faint)',
                  opacity: on ? 0.8 : 1,
                  fontSize: 10,
                }}
              >
                {count.toLocaleString('en-US')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
