import type { ReactElement } from 'react';
/**
 * Context saturation bar. Renders horizontally across the full width with a
 * CONTEXT label on the left and `N / MAX` tabular-num on the right.
 *
 * **L2.4 fix** — the number compared against `max` is the *max per-turn token
 * sum*, not the cumulative session spend. Comparing 30 M cumulative tokens to
 * a 200 k context ceiling is nonsense; the user actually wants to know how
 * close any single turn got to the wall. Cumulative is kept as a faint
 * secondary line (`cumulative 30,614,665 across 44 turns`) so provenance is
 * still visible.
 *
 * Color scheme (per plan L2.8 updated from L3.6):
 *   0 – 80 %   → amber  (peek-accent)  — reassuring default, nothing alarming
 *   80 – 100 % → amber  (peek-accent)  — same band, we're close to but under
 *   100 % +    → red    (peek-bad)     — user is actually over the ceiling
 *
 * Historically this component used a green/amber/red tri-band at
 * 60 % / 90 %. The morning-review note explicitly downgraded that: amber is
 * the new "normal", red is reserved for "you are over 200k". Tests that
 * cared about the tri-band have been updated (see context-gauge.test.tsx).
 *
 * If `tokens > max` the fill clamps to 100 % (can't overflow its bar
 * visually) and the color is forced red.
 *
 * Dual role:
 *   - Top of SessionDetailPage (full-width bar).
 *   - Top of the Inspector drawer (same component, narrower column).
 *
 * Both modes render the same component; styling is position-agnostic.
 */

import { formatTokens } from '../lib/format';

type Props = {
  /**
   * The gauge numerator — compared directly against `max`. Callers should
   * pass `maxPerTurn` from `computeContextGaugeStats`, NOT the session's
   * cumulative token total.
   */
  tokens: number;
  max?: number;
  /**
   * Optional secondary stats rendered underneath the main bar in a faint
   * monospace line: `cumulative <n> tokens across <turnCount> turns`.
   * When omitted the secondary line is hidden (keeps drawer mode tight).
   */
  cumulative?: number;
  turnCount?: number;
  /**
   * Override the root `data-testid`. Used by SessionDetailPage to emit
   * `session-context-gauge` so the drawer-scoped `context-gauge` hook stays
   * unambiguous.
   */
  testId?: string;
};

/**
 * Pick a color band given the saturation ratio.
 *
 * Post-L2.4: only two bands. Amber for anything under 100 %, red once we
 * cross it. We still expose this as a pure helper so regressions can be
 * caught without rendering.
 */
export function gaugeColor(ratio: number): string {
  if (ratio >= 1) return 'var(--peek-bad)';
  return 'var(--peek-accent)';
}

export function ContextGauge({
  tokens,
  max = 200_000,
  cumulative,
  turnCount,
  testId = 'context-gauge',
}: Props): ReactElement {
  const rawRatio = max > 0 ? tokens / max : 0;
  const clamped = Math.max(0, Math.min(1, rawRatio));
  const pct = clamped * 100;
  const over = tokens > max;
  const color = over ? 'var(--peek-bad)' : gaugeColor(clamped);

  const hasSecondary = typeof cumulative === 'number' && typeof turnCount === 'number';

  return (
    <div
      data-testid={testId}
      data-saturation={clamped.toFixed(2)}
      data-over={over ? 'true' : 'false'}
      role="group"
      aria-label={`context usage: ${formatTokens(tokens)} of ${formatTokens(max)} (max per turn)`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 24px',
        background: 'var(--peek-surface)',
        borderBottom: '1px solid var(--peek-border)',
        fontSize: 'var(--peek-fs-xs)',
        color: 'var(--peek-fg-faint)',
        letterSpacing: '0.04em',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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

      {hasSecondary && (
        <div
          data-testid="context-gauge-secondary"
          className="peek-mono"
          style={{
            alignSelf: 'flex-end',
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            letterSpacing: '0.06em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          cumulative {cumulative!.toLocaleString('en-US')} tokens across{' '}
          {turnCount!.toLocaleString('en-US')} {turnCount === 1 ? 'turn' : 'turns'}
        </div>
      )}
    </div>
  );
}
