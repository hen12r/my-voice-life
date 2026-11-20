import { describe, expect, it } from 'vitest';
import { CUES, playCue, soundEnabled } from './sound';

describe('sound cues', () => {
  it('are off by default and never throw without Web Audio', () => {
    expect(soundEnabled()).toBe(false);
    expect(() => playCue('start')).not.toThrow();
  });
  it('are short (under half a second)', () => {
    for (const { notes, step } of Object.values(CUES)) expect(notes.length * step + 0.1).toBeLessThan(0.5);
  });
});
