import type { ReactElement } from 'react';
/**
 * Horizontal token-saturation bar. Sticky at the top of the inspector.
 * Green ≤ 60 %, yellow 60–85 %, red > 85 %.
 */

import { formatTokens } from '../lib/format';

type Props = {
  tokens: number;
  max?: number;
};

export function ContextGauge({ tokens, max = 200_000 }: Props): ReactElement {
  const ratio = Math.max(0, Math.min(1, tokens / max));
  const pct = ratio * 100;
  const color =
    ratio <= 0.6 ? 'var(--peek-ok)' : ratio <= 0.85 ? 'var(--peek-warn)' : 'var(--peek-bad)';

  return (
    <div
      data-testid="context-gauge"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1,
        padding: '12px 16px',
        background: 'var(--peek-surface)',
        borderBottom: '1px solid var(--peek-border)',
      }}
    >
      <div
        className="peek-mono"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--peek-fs-xs)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--peek-fg-dim)',
          marginBottom: 6,
        }}
      >
        <span>context</span>
        <span className="peek-num" style={{ color: 'var(--peek-fg)' }}>
          {formatTokens(tokens)} / {formatTokens(max)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          background: 'var(--peek-bg)',
          border: '1px solid var(--peek-border)',
          overflow: 'hidden',
        }}
      >
        <div
          data-testid="context-gauge-fill"
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 180ms ease-out, background 180ms ease-out',
          }}
        />
      </div>
    </div>
  );
}
