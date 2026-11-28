// Reminder notifications on this device (Web Push). The browser creates the subscription with our
// PUBLIC VAPID key; we store its endpoint + encryption keys through a validated database function.
// The private key never leaves the server; reminder titles reach the device end-to-end encrypted.
import { b64urlDecode, b64urlEncode } from '../../supabase/functions/_shared/webpush.ts';
import { getPushPublicKey, removePushSubscription, savePushSubscription } from '../lib/api';

export type PushSupport = 'ok' | 'unsupported' | 'ios-install' | 'denied';

/** iPhone/iPad, any browser (iPadOS reports as a Mac with touch). */
export function isIosDevice(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Pure: what this device can do. On iOS, Web Push exists only in the installed (home-screen) app. */
export function pushSupport(env: { serviceWorker: boolean; pushManager: boolean; notification: boolean; permission: string | null; ios: boolean; standalone: boolean }): PushSupport {
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ok';
}

export function detectPushSupport(): PushSupport {
  const n = typeof navigator !== 'undefined' ? navigator : undefined;
  return pushSupport({
    serviceWorker: !!n && 'serviceWorker' in n,
    pushManager: typeof window !== 'undefined' && 'PushManager' in window,
    notification: typeof Notification !== 'undefined',
    permission: typeof Notification !== 'undefined' ? Notification.permission : null,
    ios: !!n && isIosDevice(n.userAgent, n.maxTouchPoints),
    standalone: typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (n as Navigator & { standalone?: boolean })?.standalone === true),
  });
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  // The service worker is registered in production builds only; never wait forever for it.
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) return reg;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export class PushPermissionError extends Error {}

/** Asks permission (only on the user's tap), subscribes this browser, and registers it. */
export async function enablePush(publicKey?: string): Promise<void> {
  const key = publicKey ?? await getPushPublicKey();
  if (await Notification.requestPermission() !== 'granted') throw new PushPermissionError('denied');
  const reg = await registration();
  if (!reg) throw new Error('The app needs to be reloaded once before notifications can be turned on.');
  let sub = await reg.pushManager.getSubscription();
  const wanted = b64urlDecode(key);
  // A subscription made with another server key cannot be reused.
  const existing = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && existing && b64urlEncode(existing) !== key) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser returned an incomplete subscription.');
  await savePushSubscription({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await removePushSubscription(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
