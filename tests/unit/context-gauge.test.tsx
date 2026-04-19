// @vitest-environment happy-dom
/**
 * L3.6 focused unit tests for `<ContextGauge />`.
 *
 * Scope:
 *   1. Renders `X / 200,000` with tabular-nums.
 *   2. Color bands at 50 % (green), 75 % (amber), 95 % (red) match the spec:
 *        0 – 60 %  → peek-ok
 *        60 – 90 % → peek-accent
 *        90+ %     → peek-bad
 *   3. When tokens > max the bar clamps to 100 % width and is marked `data-over`.
 *   4. `gaugeColor` pure helper picks the same bands so the threshold logic
 *      is regression-testable without rendering.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ContextGauge, gaugeColor } from '../../src/components/ContextGauge';

afterEach(() => {
  cleanup();
});

describe('gaugeColor thresholds', () => {
  it('returns ok (green) below 60%', () => {
    expect(gaugeColor(0)).toBe('var(--peek-ok)');
    expect(gaugeColor(0.5)).toBe('var(--peek-ok)');
    expect(gaugeColor(0.599)).toBe('var(--peek-ok)');
  });

  it('returns accent (amber) between 60% and 90%', () => {
    expect(gaugeColor(0.6)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.75)).toBe('var(--peek-accent)');
    expect(gaugeColor(0.899)).toBe('var(--peek-accent)');
  });

  it('returns bad (red) at or above 90%', () => {
    expect(gaugeColor(0.9)).toBe('var(--peek-bad)');
    expect(gaugeColor(0.95)).toBe('var(--peek-bad)');
    expect(gaugeColor(1)).toBe('var(--peek-bad)');
  });
});

describe('<ContextGauge /> rendering', () => {
  it('renders `X / 200,000` with tabular-nums and CONTEXT label', () => {
    render(<ContextGauge tokens={50_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.textContent).toMatch(/context/i);
    expect(gauge.textContent).toContain('50,000');
    expect(gauge.textContent).toContain('200,000');
    // The numeric element reads the monospace / tabular-nums class.
    const num = screen.getByTestId('context-gauge-num');
    expect(num.classList.contains('peek-num')).toBe(true);
  });

  it('at 50% saturation paints the fill green (ok)', () => {
    render(<ContextGauge tokens={100_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-saturation')).toBe('0.50');
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-ok');
  });

  it('at 75% saturation paints the fill amber (accent)', () => {
    render(<ContextGauge tokens={150_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-saturation')).toBe('0.75');
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-accent');
  });

  it('at 95% saturation paints the fill red (bad)', () => {
    render(<ContextGauge tokens={190_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-saturation')).toBe('0.95');
    const fill = screen.getByTestId('context-gauge-fill');
    expect(fill.style.background).toContain('--peek-bad');
  });

  it('when tokens > max, clamps to 100% and marks data-over', () => {
    render(<ContextGauge tokens={250_000} max={200_000} />);
    const gauge = screen.getByTestId('context-gauge');
    expect(gauge.getAttribute('data-over')).toBe('true');
    expect(gauge.getAttribute('data-saturation')).toBe('1.00');
    const fill = screen.getByTestId('context-gauge-fill');
    // Fill should be fully extended.
    expect(fill.style.right).toBe('0%');
    expect(fill.style.background).toContain('--peek-bad');
  });

  it('respects a custom testId prop so two gauges can coexist on one page', () => {
    render(<ContextGauge tokens={10} max={100} testId="session-context-gauge" />);
    expect(screen.getByTestId('session-context-gauge')).toBeTruthy();
    expect(screen.queryByTestId('context-gauge')).toBeNull();
  });
});
