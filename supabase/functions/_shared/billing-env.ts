// Deno-only: reads the Stripe configuration from Edge Function secrets (never from the browser,
// never from the repository). Shared by billing, stripe-webhook and delete-account.
//   STRIPE_SECRET_KEY            sk_test_… (or rk_test_… restricted key). Live keys are refused
//                                unless STRIPE_LIVE_MODE_APPROVED=true is also set.
//   STRIPE_WEBHOOK_SECRET        whsec_… signing secret of the webhook endpoint
//   STRIPE_PRICE_PLUS_MONTHLY / STRIPE_PRICE_PLUS_YEARLY   price_… for Plus (yearly optional) — not secret, kept server-side
//   STRIPE_PRICE_PRO_MONTHLY  / STRIPE_PRICE_PRO_YEARLY    price_… for Pro (yearly optional)
//   STRIPE_API_VERSION           optional override of the pinned API version
import { billingModeAllowed, createStripeClient, parsePriceConfig, type PriceConfig, type StripeClient } from './stripe.ts';

export interface BillingEnv { stripe: StripeClient | undefined; mode: 'test' | 'live' | null; prices: PriceConfig; webhookSecret: string | undefined }

export function readBillingEnv(): BillingEnv {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  const prices = parsePriceConfig({
    plusMonth: Deno.env.get('STRIPE_PRICE_PLUS_MONTHLY'), plusYear: Deno.env.get('STRIPE_PRICE_PLUS_YEARLY'),
    proMonth: Deno.env.get('STRIPE_PRICE_PRO_MONTHLY'), proYear: Deno.env.get('STRIPE_PRICE_PRO_YEARLY'),
  });
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || undefined;
  if (!key) return { stripe: undefined, mode: null, prices, webhookSecret };
  const allowed = billingModeAllowed(key, Deno.env.get('STRIPE_LIVE_MODE_APPROVED'));
  if (!allowed.ok) {
    // The reason only (never the key) — e.g. a live key without approval.
    console.error(`billing: Stripe disabled (${allowed.reason})`);
    return { stripe: undefined, mode: null, prices, webhookSecret };
  }
  return {
    stripe: createStripeClient({ secretKey: key, apiVersion: Deno.env.get('STRIPE_API_VERSION') || undefined, fetch: (...a) => fetch(...a) }),
    mode: allowed.mode,
    prices,
    webhookSecret,
  };
}
