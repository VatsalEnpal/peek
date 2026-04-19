import type { ReactElement } from 'react';
/**
 * Context saturation bar. Renders horizontally across the full width with a
 * CONTEXT label on the left and `N / MAX` tabular-num on the right.
 *
 * Color scheme (per plan L3.6 + mockup L2):
 *   0 – 60 %   → green   (peek-ok)    — plenty of head-room
 *   60 – 90 %  → amber   (peek-accent) — caution zone
 *   90+ %      → red     (peek-bad)   — nearing ceiling
 *
 * If `tokens > max` the fill clamps to 100 % (can't overflow its bar
 * visually) and the color is forced red so the user sees they're over.
 *
 * Dual role:
 *   - Top of SessionDetailPage (full-width bar).
 *   - Top of the Inspector drawer (same component, narrower column).
 * Both modes read the same tokens; styling is position-agnostic.
 */

import { formatTokens } from '../lib/format';

type Props = {
  tokens: number;
  max?: number;
  /**
   * Override the root `data-testid`. Used by SessionDetailPage to emit
   * `session-context-gauge` so the drawer-scoped `context-gauge` hook stays
   * unambiguous.
   */
  testId?: string;
};

/** Pick a color band given the saturation ratio. */
export function gaugeColor(ratio: number): string {
  if (ratio >= 0.9) return 'var(--peek-bad)';
  if (ratio >= 0.6) return 'var(--peek-accent)';
  return 'var(--peek-ok)';
}

export function ContextGauge({
  tokens,
  max = 200_000,
  testId = 'context-gauge',
}: Props): ReactElement {
  const rawRatio = max > 0 ? tokens / max : 0;
  const clamped = Math.max(0, Math.min(1, rawRatio));
  const pct = clamped * 100;
  const over = tokens > max;
  const color = over ? 'var(--peek-bad)' : gaugeColor(clamped);

  return (
    <div
      data-testid={testId}
      data-saturation={clamped.toFixed(2)}
      data-over={over ? 'true' : 'false'}
      role="group"
      aria-label={`context usage: ${formatTokens(tokens)} of ${formatTokens(max)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 24px',
        background: 'var(--peek-surface)',
        borderBottom: '1px solid var(--peek-border)',
        fontSize: 'var(--peek-fs-xs)',
        color: 'var(--peek-fg-faint)',
        letterSpacing: '0.04em',
      }}
    >
      <span
        className="peek-mono"
        style={{
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          flexShrink: 0,
        }}
      >
        context
      </span>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          flex: 1,
          height: 4,
          background: 'var(--peek-border)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          data-testid="context-gauge-fill"
          style={{
            position: 'absolute',
            inset: 0,
            right: `${100 - pct}%`,
            background: color,
            transition: 'right 180ms ease-out, background 180ms ease-out',
          }}
        />
      </div>
      <span
        className="peek-num"
        data-testid="context-gauge-num"
        style={{ color: 'var(--peek-fg)', fontWeight: 500 }}
      >
        {formatTokens(tokens)}
      </span>
      <span className="peek-num" style={{ color: 'var(--peek-fg-dim)' }}>
        / {formatTokens(max)}
      </span>
    </div>
  );
}
