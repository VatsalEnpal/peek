import type { ReactElement } from 'react';
/**
 * Level-2 / Level-3 route wrapper.
 *
 * Reads :id (required) and :spanId (optional) from the URL, pushes them into
 * the existing Zustand stores, then renders the untouched <AppShell/> so the
 * timeline/inspector implementation keeps working while routing is added.
 *
 * Open drawer state is also navigated back into the URL when the user clicks a
 * row inside AppShell — that wiring lives in TimelineRow (L3.2).
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import { AppShell } from '../components/AppShell';
import { useSessionStore } from '../stores/session';
import { useSelectionStore } from '../stores/selection';

export function SessionDetailPage(): ReactElement {
  const { id, spanId } = useParams<{ id: string; spanId?: string }>();

  const selectSession = useSessionStore((s) => s.selectSession);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const selectSpan = useSelectionStore((s) => s.selectSpan);
  const closeDrawer = useSelectionStore((s) => s.closeDrawer);

  // Load the session whenever the :id param changes.
  useEffect(() => {
    if (!id) return;
    if (id !== selectedSessionId) {
      void selectSession(id);
    }
  }, [id, selectedSessionId, selectSession]);

  // Drive drawer open/close from :spanId. This is a one-way URL→store sync; the
  // store→URL side is handled by TimelineRow / Inspector's onClose.
  useEffect(() => {
    if (spanId) {
      selectSpan(spanId);
    } else {
      closeDrawer();
    }
  }, [spanId, selectSpan, closeDrawer]);

  return <AppShell />;
}
