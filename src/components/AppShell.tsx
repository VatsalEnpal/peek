import type { ReactElement } from 'react';
/**
 * Top-level layout shell: top bar, center timeline, right inspector drawer,
 * global keyboard bindings, help overlay.
 *
 * Groups 11-13 will add the record button to the top bar — the placeholder is
 * wired here so dropping in recording-mode UIs is a one-line swap.
 */

import { useEffect, useMemo, useState } from 'react';

import { useSessionStore, buildTimelineRows } from '../stores/session';
import { useSelectionStore } from '../stores/selection';
import { useRecordingStore } from '../stores/recording';
import { bindKeyboard, type KbAction } from '../lib/keyboard';
import { SessionPicker } from './SessionPicker';
import { FilterChips } from './FilterChips';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';
import { KbHelp } from './KbHelp';
import { RecordButton } from './RecordButton';
import { FocusBar } from './FocusBar';
import { ImportDialog } from './ImportDialog';

export function AppShell(): ReactElement {
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const events = useSessionStore((s) => s.events);
  const active = useSessionStore((s) => s.activeChips);
  const expanded = useSessionStore((s) => s.expandedSpans);
  const expandSpan = useSessionStore((s) => s.expandSpan);
  const collapseSpan = useSessionStore((s) => s.collapseSpan);

  const selectedSpanId = useSelectionStore((s) => s.selectedSpanId);
  const selectSpan = useSelectionStore((s) => s.selectSpan);
  const closeDrawer = useSelectionStore((s) => s.closeDrawer);
  const toggleHelp = useSelectionStore((s) => s.toggleHelp);
  const setHelp = useSelectionStore((s) => s.setHelp);

  const [importOpen, setImportOpen] = useState<boolean>(false);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Keyboard wiring — recompute visible rows lazily inside the handler so we
  // always pick the freshest filters + expand state.
  useEffect(() => {
    const getRows = (): Array<{ id: string; hasChildren: boolean }> =>
      buildTimelineRows(
        useSessionStore.getState().events,
        useSessionStore.getState().activeChips,
        useSessionStore.getState().expandedSpans
      );
    const currentIndex = (rows: Array<{ id: string }>): number => {
      const id = useSelectionStore.getState().selectedSpanId;
      if (!id) return -1;
      return rows.findIndex((r) => r.id === id);
    };
    const handler = (a: KbAction): void => {
      const rows = getRows();
      if (
        rows.length === 0 &&
        a.kind !== 'toggle-help' &&
        a.kind !== 'close' &&
        a.kind !== 'toggle-record'
      )
        return;
      switch (a.kind) {
        case 'next': {
          const i = currentIndex(rows);
          const next = rows[Math.min(rows.length - 1, Math.max(0, i + 1))];
          if (next) selectSpan(next.id);
          break;
        }
        case 'prev': {
          const i = currentIndex(rows);
          const prev = rows[Math.max(0, i - 1)];
          if (prev) selectSpan(prev.id);
          break;
        }
        case 'expand': {
          const i = currentIndex(rows);
          const row = rows[i];
          if (row?.hasChildren) expandSpan(row.id);
          break;
        }
        case 'collapse': {
          const i = currentIndex(rows);
          const row = rows[i];
          if (row) collapseSpan(row.id);
          break;
        }
        case 'open': {
          const i = currentIndex(rows);
          const row = rows[i] ?? rows[0];
          if (row) selectSpan(row.id);
          break;
        }
        case 'close': {
          if (useSelectionStore.getState().helpOpen) setHelp(false);
          else closeDrawer();
          break;
        }
        case 'toggle-help':
          toggleHelp();
          break;
        case 'toggle-record': {
          const rec = useRecordingStore.getState();
          const sessionId = useSessionStore.getState().selectedSessionId;
          if (rec.isRecording) {
            void rec.stopRecording();
          } else if (sessionId) {
            const raw =
              typeof window !== 'undefined' && typeof window.prompt === 'function'
                ? window.prompt('Label this recording:', '')
                : '';
            void rec.startRecording(sessionId, (raw ?? '').trim());
          }
          break;
        }
      }
    };
    return bindKeyboard(handler);
  }, [selectSpan, expandSpan, collapseSpan, closeDrawer, toggleHelp, setHelp]);

  // Expose a stable summary line in the top bar — event count + selection.
  const summary = useMemo(() => {
    const rows = buildTimelineRows(events, active, expanded);
    return { visible: rows.length, total: events.filter((e) => e.kind === 'span').length };
  }, [events, active, expanded]);

  return (
    <div
      data-testid="app-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--peek-bg)',
      }}
    >
      <header
        data-testid="topbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--peek-sp-4)',
          height: 'var(--peek-topbar-h)',
          padding: '0 var(--peek-sp-4)',
          background: 'var(--peek-surface)',
          borderBottom: '1px solid var(--peek-border)',
          flexShrink: 0,
        }}
      >
        <div
          className="peek-mono"
          style={{
            fontSize: 'var(--peek-fs-md)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--peek-accent)',
          }}
        >
          peek
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--peek-border)' }} />
        <SessionPicker />
        <RecordButton />
        <button
          type="button"
          data-testid="import-btn"
          onClick={(): void => setImportOpen(true)}
          aria-label="import sessions"
          className="peek-mono"
          style={{
            padding: '4px 10px',
            background: 'transparent',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-dim)',
            fontSize: 'var(--peek-fs-xs)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Import
        </button>
        <div style={{ width: 1, height: 18, background: 'var(--peek-border)' }} />
        <FilterChips />
        <div style={{ marginLeft: 'auto' }}>
          <span
            className="peek-mono peek-dim"
            style={{ fontSize: 'var(--peek-fs-xs)', letterSpacing: '0.06em' }}
          >
            {summary.visible}/{summary.total} spans · {selectedSpanId ? 'selected' : 'idle'}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleHelp}
          className="peek-mono"
          aria-label="show keyboard shortcuts"
          style={{
            fontSize: 'var(--peek-fs-xs)',
            padding: '4px 8px',
            border: '1px solid var(--peek-border)',
            color: 'var(--peek-fg-dim)',
          }}
        >
          ?
        </button>
      </header>

      <FocusBar />

      <main
        style={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
        }}
      >
        <Timeline />
        <Inspector />
      </main>

      <KbHelp />
      <ImportDialog open={importOpen} onClose={(): void => setImportOpen(false)} />
    </div>
  );
}
