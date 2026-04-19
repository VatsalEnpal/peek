import type { ReactElement } from 'react';
/**
 * L2.7 — Right-side help drawer.
 *
 * Toggled by the `?` button in the header (and by the `?` hotkey). Slides in
 * from the right, closes on Esc or clicking the scrim. Styled to match the
 * rest of the app (dark surface, monospace labels, amber accents).
 *
 * Sections:
 *   - Recording — `/peek_start NAME` + `/peek_end` slash commands (installed
 *     via `peek install`).
 *   - Text markers (fallback) — `@peek-start NAME` + `@peek-end` inline if
 *     slash commands aren't installed yet.
 *   - Keyboard — navigation, search, bookmark hotkey.
 *   - Data source — watches `~/.claude/projects/` locally, never uploaded.
 *
 * State lives in `useSelectionStore.helpOpen` so existing `?` hotkey bindings
 * and the old `KbHelp` wiring keep working. We intentionally render this
 * instead of `KbHelp` now — the drawer is a superset of the old modal.
 */

import { useEffect } from 'react';

import { useSelectionStore } from '../stores/selection';

type Section = {
  id: string;
  title: string;
  rows: ReadonlyArray<{ keys: string; label: string }>;
  /** Optional free-form footnote rendered in a muted row below the grid. */
  note?: string;
};

const SECTIONS: ReadonlyArray<Section> = [
  {
    id: 'recording',
    title: 'recording',
    rows: [
      { keys: '/peek_start NAME', label: 'begin a bookmark (slash command)' },
      { keys: '/peek_end', label: 'close the most recent bookmark' },
    ],
    note: 'installed via `peek install` — writes to ~/.claude/commands/',
  },
  {
    id: 'text-markers',
    title: 'text markers (fallback)',
    rows: [
      { keys: '@peek-start NAME', label: 'type inline if slash commands are unavailable' },
      { keys: '@peek-end', label: 'close the most recent bookmark inline' },
    ],
  },
  {
    id: 'keyboard',
    title: 'keyboard',
    rows: [
      { keys: '↑ ↓ / j k', label: 'navigate rows' },
      { keys: '⏎', label: 'open inspector' },
      { keys: '/', label: 'focus search' },
      { keys: 'b', label: 'bookmark the current row' },
      { keys: 'esc', label: 'close drawer / help' },
    ],
  },
  {
    id: 'data-source',
    title: 'data source',
    rows: [
      { keys: '~/.claude/projects/', label: 'watched for new JSONL sessions' },
    ],
    note: 'local only — peek never uploads session data',
  },
];

export function HelpPanel(): ReactElement | null {
  const open = useSelectionStore((s) => s.helpOpen);
  const setOpen = useSelectionStore((s) => s.setHelp);

  // Esc closes the drawer even when focus isn't inside it (the global
  // keyboard handler already covers session-detail context; this extra
  // listener makes the panel work on the sessions landing page too, which
  // doesn't bind keyboard actions).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      data-testid="help-panel-root"
      role="dialog"
      aria-modal="true"
      aria-label="peek help"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      {/* scrim */}
      <button
        type="button"
        data-testid="help-panel-scrim"
        aria-label="close help"
        onClick={(): void => setOpen(false)}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(8, 9, 11, 0.72)',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      />

      {/* drawer */}
      <aside
        data-testid="help-panel"
        style={{
          position: 'relative',
          width: 'min(440px, 100%)',
          height: '100%',
          background: 'var(--peek-surface)',
          borderLeft: '1px solid var(--peek-border)',
          boxShadow: '-24px 0 48px rgba(0, 0, 0, 0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--peek-border)',
          }}
        >
          <span
            className="peek-mono"
            style={{
              color: 'var(--peek-accent)',
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontSize: 'var(--peek-fs-sm)',
            }}
          >
            help
          </span>
          <span
            style={{
              flex: 1,
              color: 'var(--peek-fg-faint)',
              fontSize: 'var(--peek-fs-xs)',
              letterSpacing: '0.03em',
            }}
          >
            how to drive peek
          </span>
          <button
            type="button"
            data-testid="help-panel-close"
            onClick={(): void => setOpen(false)}
            aria-label="close help"
            className="peek-mono"
            style={{
              background: 'transparent',
              border: '1px solid var(--peek-border)',
              color: 'var(--peek-fg-faint)',
              fontSize: 10,
              padding: '2px 8px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            esc
          </button>
        </header>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px 24px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 26,
          }}
        >
          {SECTIONS.map((s) => (
            <section key={s.id} data-testid={`help-section-${s.id}`}>
              <h3
                className="peek-mono"
                style={{
                  margin: '0 0 10px',
                  fontSize: 10,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: 'var(--peek-fg-dim)',
                  fontWeight: 500,
                }}
              >
                {s.title}
              </h3>
              <dl
                className="peek-mono"
                style={{
                  margin: 0,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '8px 16px',
                  fontSize: 'var(--peek-fs-xs)',
                }}
              >
                {s.rows.map((r) => (
                  <div key={r.keys} style={{ display: 'contents' }}>
                    <dt
                      style={{
                        color: 'var(--peek-accent)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.keys}
                    </dt>
                    <dd
                      style={{
                        margin: 0,
                        color: 'var(--peek-fg)',
                        lineHeight: 1.5,
                      }}
                    >
                      {r.label}
                    </dd>
                  </div>
                ))}
              </dl>
              {s.note !== undefined && (
                <div
                  className="peek-mono"
                  style={{
                    marginTop: 8,
                    color: 'var(--peek-fg-faint)',
                    fontSize: 10,
                    letterSpacing: '0.04em',
                    fontStyle: 'italic',
                  }}
                >
                  {s.note}
                </div>
              )}
            </section>
          ))}
        </div>

        <footer
          className="peek-mono"
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            letterSpacing: '0.12em',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>press ? anywhere to reopen</span>
          <span>peek 0.2.1</span>
        </footer>
      </aside>
    </div>
  );
}
