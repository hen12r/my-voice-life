// POST /functions/v1/billing — Stripe Checkout and Customer Portal for the signed-in user.
//   { "action": "prices" }                      public: plan limits + live prices read from Stripe
//   { "action": "checkout", "interval": "month"|"year" }  → { url } of a Stripe Checkout page
//   { "action": "portal" }                      → { url } of the Stripe Customer Portal
// The browser never sends a price id, an amount, a customer id or a redirect URL: the price comes
// from the server's allow-list, the customer from the database, the URLs from an allow-listed
// Origin. Nothing here grants Premium — only the verified webhook does that.
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { isOriginAllowed } from '../_shared/cors.ts';
import { type PriceConfig, type StripeClient, StripeApiError } from '../_shared/stripe.ts';

export interface SubscriptionRow {
  plan: string;
  status: string;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}
export interface PlanLimitsRow { plan: string; ai_captures_per_month: number; audio_minutes_per_month: number; max_capture_seconds: number }

export interface BillingStore {
  subscriptionFor(userId: string): Promise<SubscriptionRow | null>;
  linkCustomer(userId: string, customerId: string): Promise<void>;
  planLimits(): Promise<PlanLimitsRow[]>;
}

export interface BillingDeps {
  /** Undefined when Stripe isn't configured, or the key was refused by the test-mode guard. */
  stripe: StripeClient | undefined;
  mode: 'test' | 'live' | null;
  prices: PriceConfig;
  allowedOrigins: string[];
  getUser(req: Request): Promise<{ id: string; email: string | null } | null>;
  store: BillingStore;
  now?: () => number;
}

interface DisplayPrice { interval: 'month' | 'year'; amount: number; currency: string }
const PRICE_CACHE_MS = 5 * 60_000;

/** A subscription that still exists at Stripe: send the user to the portal instead of a second checkout. */
export function hasLiveSubscription(row: SubscriptionRow | null, nowMs: number): boolean {
  if (!row?.stripe_subscription_id) return false;
  if (['past_due', 'unpaid', 'paused', 'incomplete'].includes(row.status)) return true;
  return ['active', 'trialing'].includes(row.status) && (!row.current_period_end || Date.parse(row.current_period_end) > nowMs);
}

export function createBillingHandler(deps: BillingDeps) {
  const now = deps.now ?? Date.now;
  let priceCache: { at: number; prices: DisplayPrice[] } | null = null;

  async function displayPrices(): Promise<DisplayPrice[]> {
    if (!deps.stripe) return [];
    if (priceCache && now() - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
    const out: DisplayPrice[] = [];
    for (const interval of ['month', 'year'] as const) {
      const id = deps.prices[interval];
      if (!id) continue;
      const p = await deps.stripe.get(`/prices/${id}`) as {
        active?: boolean; type?: string; unit_amount?: number | null; currency?: string;
        recurring?: { interval?: string; interval_count?: number } | null;
      };
      // Show a price only if Stripe confirms it is what the slot claims: active, recurring, this interval.
      if (p.active !== true || p.type !== 'recurring' || p.recurring?.interval !== interval || (p.recurring?.interval_count ?? 1) !== 1
        || typeof p.unit_amount !== 'number' || typeof p.currency !== 'string') {
        console.error(`billing: configured ${interval} price is not an active ${interval}ly recurring price`);
        continue;
      }
      out.push({ interval, amount: p.unit_amount, currency: p.currency.toUpperCase() });
    }
    priceCache = { at: now(), prices: out };
    return out;
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const body = await req.json().catch(() => null) as { action?: unknown; interval?: unknown } | null;
    const action = body?.action;

    try {
      if (action === 'prices') {
        const limits = await deps.store.planLimits();
        const prices = await displayPrices();
        return json(req, 200, {
          configured: Boolean(deps.stripe) && prices.length > 0,
          test_mode: deps.mode === 'test',
          prices,
          limits: Object.fromEntries(limits.map((l) => [l.plan, {
            ai_captures_per_month: l.ai_captures_per_month, audio_minutes_per_month: l.audio_minutes_per_month, max_capture_seconds: l.max_capture_seconds,
          }])),
        });
      }

      if (action !== 'checkout' && action !== 'portal') return fail(req, 400, 'invalid_action', 'Unknown action');

      const user = await deps.getUser(req);
      if (!user) return fail(req, 401, 'unauthorized', 'Sign in required');
      if (!deps.stripe) return fail(req, 503, 'billing_not_configured', 'Payments are not set up yet');

      const origin = req.headers.get('origin');
      if (!origin || !isOriginAllowed(origin, deps.allowedOrigins)) return fail(req, 403, 'origin_not_allowed', 'Unknown origin');

      const row = await deps.store.subscriptionFor(user.id);

      if (action === 'portal') {
        if (!row?.stripe_customer_id) return fail(req, 409, 'no_billing_account', 'No subscription to manage yet');
        const session = await deps.stripe.post('/billing_portal/sessions', {
          customer: row.stripe_customer_id,
          return_url: `${origin}/app/settings`,
        });
        return json(req, 200, { url: session.url });
      }

      // checkout
      const interval = body?.interval;
      if (interval !== 'month' && interval !== 'year') return fail(req, 400, 'invalid_plan', 'Choose month or year');
      const priceId = deps.prices[interval];
      if (!priceId) return fail(req, 400, 'invalid_plan', 'This billing period is not available');
      if (hasLiveSubscription(row, now())) return fail(req, 409, 'already_subscribed', 'Manage your existing subscription instead');

      let customerId = row?.stripe_customer_id ?? null;
      if (!customerId) {
        const customer = await deps.stripe.post('/customers', {
          ...(user.email ? { email: user.email } : {}),
          metadata: { supabase_user_id: user.id },
        }, `mvl-customer-${user.id}`);
        customerId = String(customer.id);
        await deps.store.linkCustomer(user.id, customerId);
      }

      const session = await deps.stripe.post('/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/pricing?checkout=cancelled`,
        subscription_data: { metadata: { supabase_user_id: user.id } },
        metadata: { supabase_user_id: user.id },
      });
      return json(req, 200, { url: session.url });
    } catch (err) {
      if (err instanceof StripeApiError) {
        console.error(`billing: Stripe error ${err.status} ${err.type ?? ''} ${err.code ?? ''}`);
        return fail(req, 502, 'billing_provider_error', 'Payment provider error');
      }
      console.error('billing: unexpected error', err instanceof Error ? err.message : 'unknown');
      return fail(req, 500, 'billing_failed', 'Something went wrong');
    }
  };
}
