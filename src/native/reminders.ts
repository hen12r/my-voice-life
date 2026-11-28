// iOS app only: reminders alert you through notifications scheduled ON THE DEVICE (no server, no
// push service). Every time reminders change, the device's schedule is rebuilt from the user's own
// reminders. The web app keeps using Web Push (src/pwa/push.ts).
import type { Reminder } from '../lib/types';
import { isNativeApp } from './platform';

/** iOS keeps at most 64 pending local notifications per app; we stay under it. */
export const MAX_SCHEDULED = 60;

export interface PlannedNotification { id: number; title: string; body: string; at: Date; reminderId: string }

/** Stable positive 31-bit id from a reminder uuid (the plugin needs integer ids). */
export function notificationId(uuid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uuid.length; i++) { h ^= uuid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 1) || 1;
}

export function formatReminderTime(at: Date, timeZone: string, locale?: string): string {
  try { return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(at); }
  catch { return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at); }
}

/**
 * Pure: which alerts the device should hold. Only scheduled reminders in the future, soonest first,
 * at most MAX_SCHEDULED. A recurring reminder gets its next due time; the user moves it on with
 * "complete → next", which reschedules (the same rule as on the server).
 */
export function planNotifications(reminders: Pick<Reminder, 'id' | 'title' | 'remind_at' | 'timezone' | 'status'>[], now: Date, locale?: string): PlannedNotification[] {
  return reminders
    .filter((r) => r.status === 'scheduled' && new Date(r.remind_at).getTime() > now.getTime())
    .sort((a, b) => new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime())
    .slice(0, MAX_SCHEDULED)
    .map((r) => {
      const at = new Date(r.remind_at);
      return { id: notificationId(r.id), title: r.title.slice(0, 120), body: formatReminderTime(at, r.timezone, locale), at, reminderId: r.id };
    });
}

type Perm = 'granted' | 'denied' | 'prompt';
const plugin = async () => (await import('@capacitor/local-notifications')).LocalNotifications;

export async function nativePermission(): Promise<Perm> {
  const { display } = await (await plugin()).checkPermissions();
  return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
}

/** Asks iOS for permission. Call ONLY from a user's tap. */
export async function requestNativePermission(): Promise<Perm> {
  const { display } = await (await plugin()).requestPermissions();
  return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
}

/** Rebuilds the device's alert schedule from the given reminders. No-op on the web or without permission. */
export async function syncNativeReminders(reminders: Reminder[], now = new Date()): Promise<number> {
  if (!isNativeApp()) return 0;
  const ln = await plugin();
  if ((await ln.checkPermissions()).display !== 'granted') return 0;
  const pending = await ln.getPending();
  if (pending.notifications.length) await ln.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  const plan = planNotifications(reminders, now);
  if (plan.length) {
    await ln.schedule({
      notifications: plan.map((p) => ({ id: p.id, title: p.title, body: p.body, schedule: { at: p.at, allowWhileIdle: true }, extra: { url: '/app/schedule', reminderId: p.reminderId } })),
    });
  }
  return plan.length;
}

/** A test alert a few seconds from now, so the user can see notifications work. */
export async function scheduleNativeTest(title: string, body: string): Promise<void> {
  await (await plugin()).schedule({ notifications: [{ id: 1, title, body, schedule: { at: new Date(Date.now() + 5000) }, extra: { url: '/app/schedule' } }] });
}

/** Tapping an alert opens Schedule. */
export async function listenForNotificationTaps(): Promise<void> {
  if (!isNativeApp()) return;
  await (await plugin()).addListener('localNotificationActionPerformed', (e) => {
    const url = (e.notification.extra as { url?: string } | undefined)?.url;
    if (url && url.startsWith('/app/')) window.location.assign(url);
  });
}

/** On sign-out: remove every device alert, so one person's reminders never alert the next user. */
export async function clearNativeReminders(): Promise<void> {
  if (!isNativeApp()) return;
  const ln = await plugin();
  const pending = await ln.getPending();
  if (pending.notifications.length) await ln.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
}
