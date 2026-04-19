// @vitest-environment happy-dom
/**
 * L2.4 focused unit tests for `<ContextGauge />`.
 *
 * Scope:
 *   1. Renders `X / 200,000` with tabular-nums.
 *   2. Color: amber under 100 %, red at/above 100 %  (post-L2.4 downgrade
 *      from the old green/amber/red tri-band — see component docstring).
 *   3. When tokens > max the bar clamps to 100 % width and is marked `data-over`.
 *   4. `gaugeColor` pure helper matches the two-band rule.
 *   5. Secondary line renders only when both `cumulative` + `turnCount` are
 *      supplied, and reads as "cumulative N tokens across M turns".
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ContextGauge, gaugeColor } from '../../src/components/ContextGauge';

afterEach(() => {
  cleanup();
});

describe('gaugeColor thresholds (L2.4 two-band)', () => {
  it('returns accent (amber) anywhere under 100%', () => {
    expect(gaugeColor(0)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.5)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.8)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.95)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.999)).toBe('var(--peek-accent)');
  });

  it('returns bad (red) at or above 100%', () => {
    expect(gaugeColor(1)).toBe('var(--peek-bad)');
    expect(gaugeColor(1.5)).toBe('var(--peek-bad)');
  });
});

describe('<ContextGauge /> rendering', () => {
  it('renders `X / 200,000` with tabular-nums and CONTEXT label', () => {
    render(<ContextGauge tokens={50_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.textContent).toMatch(/context/i);
    expect(gauge.textContent).toContain('50,000');
    expect(gauge.textContent).toContain('200,000');
    const num = screen.getByTestId('context-gauge-num');
    expect(num.classList.contains('peek-num')).toBe(true);
  });

  it('paints the fill amber at any saturation under 100%', () => {
    render(<ContextGauge tokens={150_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-saturation')).toBe('0.75');
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-accent');
  });

  it('stays amber at 95 % (tolerance zone, not red)', () => {
    render(<ContextGauge tokens={190_000} max={200_000} />);
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-accent');
  });

  it('paints red only once saturation reaches/exceeds 100 %', () => {
    render(<ContextGauge tokens={200_000} max={200_000} />);
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-bad');
  });

  it('when tokens > max, clamps to 100% and marks data-over', () => {
    render(<ContextGauge tokens={250_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-over')).toBe('true');
    expect(gauge.getAttribute('data-saturation')).toBe('1.00');
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.right).toBe('0%');
    expect(fill.style.background).toContain('--peek-bad');
  });

  it('respects a custom testId prop so two gauges can coexist on one page', () => {
    render(<ContextGauge tokens={10} max={100} testId="session-context-gauge" />);
    expect(screen.getByTestId('session-context-gauge')).toBeTruthy();
    expect(screen.queryByTestId('context-gauge')).toBeNull();
  });

  it('hides the secondary line when cumulative/turnCount are not provided', () => {
    render(<ContextGauge tokens={100} />);
    expect(screen.queryByTestId('context-gauge-secondary')).toBeNull();
  });

  it('renders secondary line "cumulative N tokens across M turns" when provided', () => {
    render(<ContextGauge tokens={159_806} cumulative={30_614_665} turnCount={44} />);
    const sec = screen.getByTestId('context-gauge-secondary');
    expect(sec.textContent).toContain('30,614,665');
    expect(sec.textContent).toContain('44');
    expect(sec.textContent?.toLowerCase()).toContain('cumulative');
    expect(sec.textContent?.toLowerCase()).toContain('turns');
  });

  it('uses singular "turn" when turnCount is 1', () => {
    render(<ContextGauge tokens={100} cumulative={100} turnCount={1} />);
    const sec = screen.getByTestId('context-gauge-secondary');
    expect(sec.textContent).toMatch(/1 turn(?!s)/);
  });
});
