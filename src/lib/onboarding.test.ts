import { describe, expect, it } from 'vitest';
import { isOnboarded, setOnboarded, shouldOnboard } from './onboarding';

describe('onboarding', () => {
  const empty = { notes: 0, tasks: 0, reminders: 0, events: 0 };
  it('shows only for an unseen, empty account', () => {
    expect(shouldOnboard(false, empty)).toBe(true);
    expect(shouldOnboard(true, empty)).toBe(false);
    expect(shouldOnboard(false, { ...empty, notes: 1 })).toBe(false);
    expect(shouldOnboard(false, { ...empty, events: 2 })).toBe(false);
  });
  it('never nags when storage is unavailable', () => {
    expect(isOnboarded()).toBe(true);
    expect(() => setOnboarded(true)).not.toThrow();
  });
});
