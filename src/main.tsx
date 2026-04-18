// Stub — implemented in Group 8 onwards. Placeholder to make the build pass.
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
