import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAudioDuration, sniffContainer } from './audio-duration.ts';

// Fixtures: chrome-*.webm were recorded by Chromium's real MediaRecorder (fake microphone);
// the others were made with ffmpeg. Reference durations from ffprobe (last packet + frame).
const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('parseAudioDuration', () => {
  it.each([
    ['chrome-4s.webm', 3.9, 4.0],      // MediaRecorder WebM has NO duration header (ffprobe: N/A)
    ['chrome-9s.webm', 8.94, 9.05],
    ['lowrate-60s.webm', 59.9, 60.1],  // 60 s in 52 KB: a size-based guess would say ~13 s
    ['ogg-7s.ogg', 7.29, 7.31],
    ['frag-7s.mp4', 7.3, 7.33],        // fragmented MP4 (as Safari records)
    ['plain-7s.m4a', 7.29, 7.33],
  ])('%s → between %s and %s s', (name, min, max) => {
    const d = parseAudioDuration(fx(name));
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThanOrEqual(min);
    expect(d!).toBeLessThanOrEqual(max);
  });
  it('identifies containers by their bytes, not by the declared MIME type', () => {
    expect(sniffContainer(fx('chrome-4s.webm'))).toBe('webm');
    expect(sniffContainer(fx('ogg-7s.ogg'))).toBe('ogg');
    expect(sniffContainer(fx('frag-7s.mp4'))).toBe('mp4');
    expect(sniffContainer(fx('garbage.bin'))).toBeNull();
  });
  it('returns null for unknown data and never throws on truncated input', () => {
    expect(parseAudioDuration(fx('garbage.bin'))).toBeNull();
    expect(parseAudioDuration(new Uint8Array(0))).toBeNull();
    const truncated = parseAudioDuration(fx('truncated-chrome.webm'));
    expect(truncated === null || truncated < 9).toBe(true);
    for (const name of ['chrome-9s.webm', 'ogg-7s.ogg', 'frag-7s.mp4']) {
      const b = fx(name);
      for (const cut of [10, 50, 200, 1000]) expect(() => parseAudioDuration(b.slice(0, cut))).not.toThrow();
    }
  });
});
