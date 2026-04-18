import type { ReactElement } from 'react';
/**
 * Native `<select>` dropdown — keeps velocity up and accessibility free.
 */

import { useSessionStore } from '../stores/session';
import { truncate } from '../lib/format';

export function SessionPicker(): ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const loading = useSessionStore((s) => s.sessionsLoading);
  const error = useSessionStore((s) => s.sessionsError);
  const selectSession = useSessionStore((s) => s.selectSession);

  return (
    <label
      data-testid="session-picker"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--peek-sp-2)',
        fontSize: 'var(--peek-fs-sm)',
        color: 'var(--peek-fg-dim)',
      }}
    >
      <span
        className="peek-mono"
        style={{ fontSize: 'var(--peek-fs-xs)', letterSpacing: '0.08em' }}
      >
        SESSION
      </span>
      <select
        value={selectedId ?? ''}
        disabled={loading || sessions.length === 0}
        onChange={(e): void => {
          const id = e.target.value || null;
          void selectSession(id);
        }}
        style={{
          background: 'var(--peek-surface-2)',
          color: 'var(--peek-fg)',
          border: '1px solid var(--peek-border)',
          padding: '4px 8px',
          fontFamily: 'var(--peek-font-mono)',
          fontSize: 'var(--peek-fs-sm)',
          minWidth: 280,
          maxWidth: 520,
        }}
      >
        {sessions.length === 0 && <option value="">{loading ? 'loading…' : 'no sessions'}</option>}
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {truncate(s.label, 60)} · {s.timeAgo}
          </option>
        ))}
      </select>
      {error !== null && (
        <span style={{ color: 'var(--peek-bad)', fontSize: 'var(--peek-fs-xs)' }}>
          {truncate(error, 40)}
        </span>
      )}
    </label>
  );
}
