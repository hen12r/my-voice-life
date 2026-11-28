import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTheme, getThemePref, resolveTheme, setThemePref, watchSystemTheme } from './theme';

describe('theme', () => {
  it('resolves system / light / dark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('defaults to system and never throws without storage, DOM or matchMedia', () => {
    expect(getThemePref()).toBe('system');
    expect(() => setThemePref('dark')).not.toThrow();
    expect(applyTheme('dark')).toBe('dark');
    expect(applyTheme('system')).toBe('light');
    expect(() => watchSystemTheme()()).not.toThrow();
  });
  it('the pre-paint script uses the same storage key and values', () => {
    const js = readFileSync(new URL('../../public/theme.js', import.meta.url), 'utf8');
    expect(js).toContain("localStorage.getItem('mvl-theme')");
    expect(js).toContain('(prefers-color-scheme: dark)');
    expect(js).toContain("'data-theme'");
  });
});
