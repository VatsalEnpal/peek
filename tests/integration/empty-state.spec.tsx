// @vitest-environment happy-dom
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EmptyState } from '../../src/components/EmptyState';

describe('EmptyState (Task 15.1)', () => {
  test('no-sessions renders import CTA', () => {
    render(<EmptyState kind="no-sessions" />);
    expect(screen.getByTestId('empty-no-sessions')).toBeInTheDocument();
    expect(screen.getByText(/Import/)).toBeInTheDocument();
  });

  test('no-events-in-focus renders', () => {
    render(<EmptyState kind="no-events-in-focus" />);
    expect(screen.getByTestId('empty-no-events-in-focus')).toBeInTheDocument();
  });

  test('subagent-sidecar-missing includes agentId', () => {
    render(<EmptyState kind="subagent-sidecar-missing" agentId="abc123" />);
    expect(screen.getByTestId('empty-subagent-missing')).toHaveTextContent('agent-abc123');
  });

  test('tool-output-truncated shows token + char counts', () => {
    render(<EmptyState kind="tool-output-truncated" totalTokens={16400} shownChars={820} />);
    const el = screen.getByTestId('empty-output-truncated');
    expect(el).toHaveTextContent('16,400');
    expect(el).toHaveTextContent('820');
  });

  test('no-bookmarks renders record CTA', () => {
    render(<EmptyState kind="no-bookmarks" />);
    expect(screen.getByTestId('empty-no-bookmarks')).toBeInTheDocument();
    expect(screen.getByText(/Record/)).toBeInTheDocument();
  });
});
