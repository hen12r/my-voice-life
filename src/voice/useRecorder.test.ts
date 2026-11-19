import { describe, expect, it } from 'vitest';
import { formatDuration, micErrorFromException } from './useRecorder';

const err = (name: string) => Object.assign(new Error(name), { name });

describe('micErrorFromException', () => {
  it.each([
    ['NotAllowedError', 'denied'],          // user clicked "Block" (Chrome, Firefox, Safari)
    ['PermissionDeniedError', 'denied'],    // legacy Chrome
    ['SecurityError', 'denied'],
    ['NotFoundError', 'no_device'],
    ['DevicesNotFoundError', 'no_device'],
    ['NotReadableError', 'busy'],           // in use by another app / OS-level block
    ['TrackStartError', 'busy'],
    ['AbortError', 'busy'],
    ['NotSupportedError', 'unsupported'],
    ['TypeError', 'unsupported'],
    ['SomethingElse', 'failed'],
  ])('%s → %s', (name, expected) => {
    expect(micErrorFromException(err(name))).toBe(expected);
  });
  it('handles non-error values', () => {
    expect(micErrorFromException(undefined)).toBe('failed');
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(3_900)).toBe('0:03');
    expect(formatDuration(125_000)).toBe('2:05');
  });
});
