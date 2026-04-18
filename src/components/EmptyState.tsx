import type { ReactElement } from 'react';

export type EmptyStateKind =
  | 'no-sessions'
  | 'no-events-in-focus'
  | 'subagent-sidecar-missing'
  | 'tool-output-truncated'
  | 'no-bookmarks';

type Props =
  | { kind: 'no-sessions' }
  | { kind: 'no-events-in-focus' }
  | { kind: 'subagent-sidecar-missing'; agentId: string }
  | {
      kind: 'tool-output-truncated';
      totalTokens: number;
      shownChars: number;
      onExpand?: () => void;
    }
  | { kind: 'no-bookmarks' };

const containerStyle: React.CSSProperties = {
  padding: 'var(--peek-sp-6, 24px)',
  color: 'var(--peek-fg-dim, #8b92a0)',
  fontSize: '13px',
  lineHeight: 1.5,
  textAlign: 'center',
  border: '1px dashed var(--peek-border, #242832)',
  borderRadius: 4,
  maxWidth: 480,
  margin: '48px auto',
};

export function EmptyState(props: Props): ReactElement {
  switch (props.kind) {
    case 'no-sessions':
      return (
        <div role="status" style={containerStyle} data-testid="empty-no-sessions">
          No sessions yet. Click <strong>Import</strong> to scan <code>~/.claude/projects/</code>.
          <br />
          Nothing imports without your explicit approval.
        </div>
      );
    case 'no-events-in-focus':
      return (
        <div role="status" style={containerStyle} data-testid="empty-no-events-in-focus">
          Focus range contains no events.
        </div>
      );
    case 'subagent-sidecar-missing':
      return (
        <div role="status" style={containerStyle} data-testid="empty-subagent-missing">
          Subagent <code>agent-{props.agentId}</code> — transcript not found on disk (interrupted
          run or older Claude Code version).
        </div>
      );
    case 'tool-output-truncated':
      return (
        <div role="status" style={containerStyle} data-testid="empty-output-truncated">
          {props.totalTokens.toLocaleString()} tokens · {props.shownChars.toLocaleString()} chars
          shown
          {props.onExpand ? (
            <>
              {' · '}
              <button
                type="button"
                onClick={props.onExpand}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--peek-accent, #ffb454)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                expand
              </button>
            </>
          ) : null}
        </div>
      );
    case 'no-bookmarks':
      return (
        <div role="status" style={containerStyle} data-testid="empty-no-bookmarks">
          No recordings or focus ranges yet. Click <strong>● Record</strong> or right-click a row.
        </div>
      );
  }
}
