import { describe, expect, it } from 'vitest';
import { isIosDevice, pushSupport } from './push';

const base = { serviceWorker: true, pushManager: true, notification: true, permission: 'default', ios: false, standalone: false };

describe('push support', () => {
  it('works in a normal desktop/Android browser', () => {
    expect(pushSupport(base)).toBe('ok');
  });
  it('on iPhone/iPad, requires the installed app first', () => {
    expect(pushSupport({ ...base, ios: true })).toBe('ios-install');
    expect(pushSupport({ ...base, ios: true, standalone: true })).toBe('ok');
  });
  it('reports unsupported browsers and blocked permission', () => {
    expect(pushSupport({ ...base, pushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...base, permission: 'denied' })).toBe('denied');
  });
  it('detects iPhone, iPad and iPadOS-as-Mac', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 15)')).toBe(false);
  });
});
