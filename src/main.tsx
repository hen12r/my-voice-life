import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initPwa } from './pwa/pwa';
import { applyTheme, watchSystemTheme } from './lib/theme';

// Service worker only in production builds (dev keeps hot reload predictable).
initPwa({ registerServiceWorker: import.meta.env.PROD });
applyTheme();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
