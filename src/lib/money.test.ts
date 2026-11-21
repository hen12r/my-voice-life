import { describe, expect, it } from 'vitest';
import { formatStripeAmount } from './money';

describe('formatStripeAmount', () => {
  it('divides two-decimal currencies by 100', () => {
    expect(formatStripeAmount(499, 'eur', 'en-GB')).toBe('€4.99');
    expect(formatStripeAmount(3999, 'USD', 'en-US')).toBe('$39.99');
  });
  it('does not divide zero-decimal currencies (Rwandan franc, Ugandan shilling, yen)', () => {
    expect(formatStripeAmount(5000, 'RWF', 'en-GB')).toContain('5,000');
    expect(formatStripeAmount(5000, 'RWF', 'en-GB')).not.toContain('50.00');
    expect(formatStripeAmount(10000, 'ugx', 'en-GB')).toContain('10,000');
    expect(formatStripeAmount(500, 'JPY', 'en-GB')).toContain('500');
  });
  it('follows the locale', () => {
    expect(formatStripeAmount(499, 'EUR', 'fr-FR').replace(/\s/g, ' ')).toBe('4,99 €');
  });
});
