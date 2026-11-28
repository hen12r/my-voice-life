import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initPwa } from './pwa/pwa';
import { applyTheme, watchSystemTheme } from './lib/theme';
import { isNativeApp } from './native/platform';
import { listenForNotificationTaps } from './native/reminders';

// Service worker only in production web builds (dev keeps hot reload predictable; the iOS app
// bundles its files and uses device notifications instead).
initPwa({ registerServiceWorker: import.meta.env.PROD && !isNativeApp() });
void listenForNotificationTaps();
applyTheme();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
