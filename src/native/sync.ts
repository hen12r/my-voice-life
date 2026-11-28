// iOS app: rebuild the device's reminder alerts from the server (the source of truth).
import { listReminders } from '../lib/api';
import { isNativeApp } from './platform';
import { syncNativeReminders } from './reminders';

export async function resyncNativeReminders(): Promise<void> {
  if (!isNativeApp()) return;
  try { await syncNativeReminders(await listReminders()); } catch { /* offline or no permission: next sync fixes it */ }
}
