import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ShutdownWarning } from './ShutdownWarning.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

/*
 * Two screens, one bundle.
 *
 * The shutdown overlay is a second BrowserWindow rather than a second build:
 * it wants the same theme, the same fonts and the same snapshot feed, and a
 * separate vite entry would have been three copies of that to keep in step. Main
 * loads the same file with `#shutdown-warning` on it — see `main/shutdown.ts`.
 */
const isWarning = window.location.hash === '#shutdown-warning';
createRoot(container).render(isWarning ? <ShutdownWarning /> : <App />);
