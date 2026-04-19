// @vitest-environment happy-dom
/**
 * L2.7 unit tests for `<HelpPanel />`.
 *
 * Scope:
 *   1. Renders nothing when `helpOpen` is false.
 *   2. When opened, all four documented sections appear: recording, text-
 *      markers, keyboard, data-source.
 *   3. Slash-command content ("/peek_start", "/peek_end") is visible and so
 *      are the text-marker fallbacks ("@peek-start", "@peek-end").
 *   4. Esc closes the drawer.
 *   5. Clicking the scrim closes the drawer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HelpPanel } from '../../src/components/HelpPanel';
import { useSelectionStore } from '../../src/stores/selection';

beforeEach(() => {
  useSelectionStore.setState({
    selectedSpanId: null,
    drawerOpen: false,
    helpOpen: false,
    focusRange: {},
    contextMenuRowId: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('<HelpPanel />', () => {
  it('renders nothing when helpOpen is false', () => {
    render(<HelpPanel />);
    expect(screen.queryByTestId('help-panel')).toBeNull();
  });

  it('shows all four sections when opened', () => {
    useSelectionStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    expect(screen.getByTestId('help-section-recording')).toBeTruthy();
    expect(screen.getByTestId('help-section-text-markers')).toBeTruthy();
    expect(screen.getByTestId('help-section-keyboard')).toBeTruthy();
    expect(screen.getByTestId('help-section-data-source')).toBeTruthy();
  });

  it('documents slash commands and text-marker fallbacks', () => {
    useSelectionStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    const drawer = screen.getByTestId('help-panel');
    const text = drawer.textContent ?? '';
    expect(text).toContain('/peek_start');
    expect(text).toContain('/peek_end');
    expect(text).toContain('@peek-start');
    expect(text).toContain('@peek-end');
    expect(text).toContain('~/.claude/projects/');
  });

  it('Esc closes the drawer', () => {
    useSelectionStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    expect(useSelectionStore.getState().helpOpen).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useSelectionStore.getState().helpOpen).toBe(false);
  });

  it('clicking the scrim closes the drawer', () => {
    useSelectionStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    const scrim = screen.getByTestId('help-panel-scrim');
    fireEvent.click(scrim);
    expect(useSelectionStore.getState().helpOpen).toBe(false);
  });

  it('close button also closes the drawer', () => {
    useSelectionStore.setState({ helpOpen: true });
    render(<HelpPanel />);
    fireEvent.click(screen.getByTestId('help-panel-close'));
    expect(useSelectionStore.getState().helpOpen).toBe(false);
  });
});
