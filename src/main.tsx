import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initPwa } from './pwa/pwa';

// Service worker only in production builds (dev keeps hot reload predictable).
initPwa({ registerServiceWorker: import.meta.env.PROD });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
