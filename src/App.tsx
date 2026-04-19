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

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SessionsPage />} />
        <Route path="/session/:id" element={<SessionDetailPage />} />
        <Route path="/session/:id/span/:spanId" element={<SessionDetailPage />} />
        {/* Deep links to any unknown path fall back to the sessions landing. */}
        <Route path="*" element={<SessionsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
