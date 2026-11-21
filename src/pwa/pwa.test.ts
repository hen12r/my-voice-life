import { describe, expect, it } from 'vitest';
import { isIosSafari } from './pwa';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  ipadOs: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
};

describe('isIosSafari (decides whether to show the manual "Add to Home Screen" steps)', () => {
  it('iPhone Safari: yes', () => expect(isIosSafari(UA.iphoneSafari)).toBe(true));
  it('iPadOS Safari (reports as a Mac, but has touch): yes', () => expect(isIosSafari(UA.ipadOs, 5)).toBe(true));
  it('a real Mac with Safari (no touch): no', () => expect(isIosSafari(UA.ipadOs, 0)).toBe(false));
  it('Chrome on iPhone cannot install web apps: no', () => expect(isIosSafari(UA.iphoneChrome)).toBe(false));
  it('Android and Windows use the browser install prompt instead: no', () => {
    expect(isIosSafari(UA.androidChrome)).toBe(false);
    expect(isIosSafari(UA.windowsEdge)).toBe(false);
  });
});
