// Installable-app state: service worker updates, install prompt, standalone mode, connectivity.
// A tiny external store (useSyncExternalStore) so any component can read it without a provider.
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** A new version is installed and waiting; call applyUpdate() to switch (reloads the page). */
  updateReady: boolean;
  /** The browser offered an install prompt (Chrome/Edge on Android, Windows, macOS, Linux). */
  canInstall: boolean;
  /** Running as an installed app (standalone window / home-screen app). */
  standalone: boolean;
  /** iPhone/iPad Safari, where installing is manual ("Share → Add to Home Screen"). */
  iosSafari: boolean;
  online: boolean;
}

let state: PwaState = {
  updateReady: false, canInstall: false, standalone: false, iosSafari: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
let waitingWorker: ServiceWorker | null = null;
let installEvent: BeforeInstallPromptEvent | null = null;
let updateAccepted = false;

/** iOS/iPadOS Safari (not Chrome/Firefox on iOS, which can't install web apps). iPadOS reports as Mac with touch. */
export function isIosSafari(ua: string, maxTouchPoints = 0): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export function initPwa(opts: { registerServiceWorker: boolean }) {
  if (typeof window === 'undefined') return;
  const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
  set({
    standalone: Boolean(standaloneQuery?.matches || (navigator as Navigator & { standalone?: boolean }).standalone),
    iosSafari: isIosSafari(navigator.userAgent, navigator.maxTouchPoints),
    online: navigator.onLine,
  });
  standaloneQuery?.addEventListener?.('change', (e) => set({ standalone: e.matches }));
  window.addEventListener('online', () => set({ online: true }));
  window.addEventListener('offline', () => set({ online: false }));
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    installEvent = e as BeforeInstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => { installEvent = null; set({ canInstall: false, standalone: true }); });

  if (!opts.registerServiceWorker || !('serviceWorker' in navigator)) return;
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const offer = (w: ServiceWorker | null) => { if (w && navigator.serviceWorker.controller) { waitingWorker = w; set({ updateReady: true }); } };
      offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
      // Reload only after the USER accepted an update (not on the very first install).
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateAccepted) window.location.reload(); });
      // Long-lived tabs and installed apps check for a new version every hour.
      setInterval(() => { reg.update().catch(() => undefined); }, 60 * 60 * 1000);
    } catch {
      // No service worker (private mode, unsupported browser): the app still works online.
    }
  };
  if (document.readyState === 'complete') void register(); else window.addEventListener('load', () => void register(), { once: true });
}

export function applyUpdate() {
  if (!waitingWorker) return;
  updateAccepted = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

/** Shows the browser's install dialog. Resolves true if the user installed. */
export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  const ev = installEvent;
  installEvent = null;
  set({ canInstall: false });
  await ev.prompt();
  return (await ev.userChoice).outcome === 'accepted';
}

export function usePwa(): PwaState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => state);
}
