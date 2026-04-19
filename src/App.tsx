import type { ReactElement } from 'react';
/**
 * Root component — wires react-router-dom and the three top-level routes:
 *
 *   /                                   → SessionsPage (L1 landing)
 *   /session/:id                        → SessionDetailPage (L2 timeline)
 *   /session/:id/span/:spanId           → SessionDetailPage with Inspector open
 *
 * The server SPA fallback (see server/static.ts) ensures any deep-link hits
 * index.html so the router takes over client-side.
 */

import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { SessionsPage } from './pages/SessionsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { RecordingsPage } from './pages/RecordingsPage';
import { RecordingDetailPage } from './pages/RecordingDetailPage';

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        {/* v0.3: landing is now the recordings list. */}
        <Route path="/" element={<RecordingsPage />} />
        <Route path="/recording/:id" element={<RecordingDetailPage />} />
        {/* Legacy sessions views still reachable for `peek import` users. */}
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/session/:id" element={<SessionDetailPage />} />
        <Route path="/session/:id/span/:spanId" element={<SessionDetailPage />} />
        {/* Deep links to any unknown path fall back to the recordings landing. */}
        <Route path="*" element={<RecordingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
