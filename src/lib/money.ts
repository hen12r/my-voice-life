// Formats a Stripe amount (in the currency's smallest unit) for display.
// Zero-decimal currencies (e.g. RWF, UGX, JPY) are NOT divided by 100 — list from Stripe's docs
// ("Zero-decimal currencies").
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

export function formatStripeAmount(amount: number, currency: string, locale: string): string {
  const cur = currency.toUpperCase();
  const value = ZERO_DECIMAL.has(cur) ? amount : amount / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).format(value);
}
