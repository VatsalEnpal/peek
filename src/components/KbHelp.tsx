import type { ReactElement } from 'react';
/**
 * `?`-toggled keyboard shortcut overlay. Rendered as a portal-less fixed div
 * so it composes cleanly even when the test env lacks `<dialog>` support.
 */

import { useSelectionStore } from '../stores/selection';

const BINDINGS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'j / ↓', label: 'next row' },
  { keys: 'k / ↑', label: 'previous row' },
  { keys: 'h / ←', label: 'collapse cascade' },
  { keys: 'l / →', label: 'expand cascade' },
  { keys: 'enter', label: 'open inspector' },
  { keys: 'esc', label: 'close inspector / help' },
  { keys: '?', label: 'toggle this panel' },
];

export function KbHelp(): ReactElement | null {
  const open = useSelectionStore((s) => s.helpOpen);
  const setOpen = useSelectionStore((s) => s.setHelp);
  if (!open) return null;
  return (
    <div
      data-testid="kb-help"
      role="dialog"
      aria-modal="true"
      aria-label="keyboard shortcuts"
      onClick={(): void => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8,9,11,0.78)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e): void => e.stopPropagation()}
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--peek-surface)',
          border: '1px solid var(--peek-border)',
          padding: 20,
        }}
      >
        <div
          className="peek-mono"
          style={{
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--peek-fg-dim)',
            marginBottom: 16,
          }}
        >
          keyboard
        </div>
        <dl
          className="peek-mono"
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 16px',
            fontSize: 'var(--peek-fs-sm)',
          }}
        >
          {BINDINGS.map((b) => (
            <div key={b.keys} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--peek-accent)' }}>{b.keys}</dt>
              <dd style={{ margin: 0, color: 'var(--peek-fg)' }}>{b.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
