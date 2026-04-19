/**
 * Recording detail page — L4 populates the full Ctrl+O-equivalent event log.
 *
 * For L3 this is a minimal scaffold so the route resolves and the back-link
 * returns to the recordings list. The real timeline, expandable tool-call
 * rows, subagent surfacing, and lifecycle toggle land in L4.
 */

import { useParams, Link } from 'react-router-dom';
import { type ReactElement } from 'react';

export function RecordingDetailPage(): ReactElement {
  const { id = '' } = useParams<{ id: string }>();

  return (
    <div
      data-testid="recording-detail-page"
      style={{
        minHeight: '100dvh',
        background: 'var(--peek-bg)',
        color: 'var(--peek-fg)',
        fontFamily: 'var(--peek-font-mono)',
      }}
    >
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: 40 }}>
        <Link
          to="/"
          data-testid="recording-back"
          style={{
            display: 'inline-block',
            color: 'var(--peek-fg-faint)',
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            marginBottom: 24,
          }}
        >
          ← back to recordings
        </Link>
        <div
          style={{
            border: '1px solid var(--peek-border)',
            background: 'var(--peek-surface)',
            padding: 40,
            color: 'var(--peek-fg-dim)',
          }}
        >
          <div style={{ color: 'var(--peek-fg)', fontSize: 'var(--peek-fs-lg)' }}>
            recording {id}
          </div>
          <div style={{ marginTop: 12, color: 'var(--peek-fg-faint)' }}>
            timeline coming in L4 — this placeholder lets the route round-trip.
          </div>
        </div>
      </div>
    </div>
  );
}
