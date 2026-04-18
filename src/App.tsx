import type { ReactElement } from 'react';
/**
 * Root component. Everything lives inside <AppShell/>.
 */

import { AppShell } from './components/AppShell';

export function App(): ReactElement {
  return <AppShell />;
}
