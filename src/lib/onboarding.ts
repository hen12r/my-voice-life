// First-run introduction. Shown once per device, and only to accounts that have nothing yet, so
// existing users never see it. A per-device convenience (localStorage), never needed for anything
// to work; every storage access is guarded.

const KEY = 'mvl-onboarded';

export function isOnboarded(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; } // no storage: never nag
}
export function setOnboarded(done: boolean): void {
  try { if (done) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** Show the introduction when it hasn't been seen on this device AND the account is empty. */
export function shouldOnboard(seen: boolean, counts: { notes: number; tasks: number; reminders: number; events: number }): boolean {
  return !seen && counts.notes + counts.tasks + counts.reminders + counts.events === 0;
}
