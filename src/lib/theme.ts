// Light / dark theme. The preference ("system" by default) is a per-device convenience kept in
// localStorage; every access is guarded because storage can be unavailable. public/theme.js applies
// the same logic before the first paint so the page never flashes the wrong theme.

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark'];

const KEY = 'mvl-theme';
const QUERY = '(prefers-color-scheme: dark)';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

export function applyTheme(pref: ThemePref = getThemePref()): Theme {
  const theme = resolveTheme(pref, systemDark());
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

export function setThemePref(pref: ThemePref): Theme {
  try {
    if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* storage unavailable: applies for this visit only */ }
  return applyTheme(pref);
}

/** Follows the operating system's setting while the preference is "system". Returns a cleanup. */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(QUERY);
  const onChange = () => { if (getThemePref() === 'system') applyTheme('system'); };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
