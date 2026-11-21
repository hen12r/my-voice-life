// POST /functions/v1/billing — plans, Stripe Checkout, plan changes, Customer Portal, invoices.
//   { "action": "prices" }                         public: Plus/Pro monthly prices read from Stripe + plan limits
//   { "action": "checkout", "plan": "plus"|"pro" } → { url } of a Stripe Checkout page (new subscribers)
//   { "action": "change_plan", "plan": "plus"|"pro" } → { url } of a Stripe portal page confirming the switch
//   { "action": "portal" }                          → { url } of the Customer Portal (card, cancel, invoices)
//   { "action": "invoices" }                        → the signed-in user's last 12 invoices (Stripe-hosted links only)
// The browser sends at most a plan NAME. It never sends a price id, an amount, a customer id or a
// redirect URL: prices come from the server's allow-list, the customer from the database, the URLs
// from an allow-listed Origin. Nothing here grants a plan — only the verified webhook does that.
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { isOriginAllowed } from '../_shared/cors.ts';
import { isPaidPlan, PAID_PLANS, type PaidPlan, type PriceConfig, type StripeClient, StripeApiError } from '../_shared/stripe.ts';

export interface SubscriptionRow {
  plan: string;
  status: string;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}
export interface PlanLimitsRow {
  plan: string;
  max_active_reminders: number | null;
  max_upcoming_events: number | null;
  max_ai_connections: number;
  byoai_captures_per_hour: number;
  byoai_captures_per_day: number;
  byoai_max_capture_seconds: number;
}

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

interface DisplayPrice { plan: PaidPlan; interval: 'month'; amount: number; currency: string }
export interface InvoiceSummary {
  id: string; number: string | null; created: string; amount: number; currency: string; status: string | null; url: string | null;
}
const PRICE_CACHE_MS = 5 * 60_000;

/** A subscription that still exists at Stripe: plan changes go through the portal, never a second checkout. */
export function hasLiveSubscription(row: SubscriptionRow | null, nowMs: number): boolean {
  if (!row?.stripe_subscription_id) return false;
  if (['past_due', 'unpaid', 'paused', 'incomplete'].includes(row.status)) return true;
  return ['active', 'trialing'].includes(row.status) && (!row.current_period_end || Date.parse(row.current_period_end) > nowMs);
}

/** Only Stripe-hosted invoice pages are passed to the browser. */
export function safeInvoiceUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'invoice.stripe.com' || url.hostname === 'pay.stripe.com') ? url.toString() : null;
  } catch { return null; }
}

export function createBillingHandler(deps: BillingDeps) {
  const now = deps.now ?? Date.now;
  let priceCache: { at: number; prices: DisplayPrice[] } | null = null;

  async function displayPrices(): Promise<DisplayPrice[]> {
    if (!deps.stripe) return [];
    if (priceCache && now() - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
    const out: DisplayPrice[] = [];
    for (const plan of PAID_PLANS) {
      const id = deps.prices[plan];
      if (!id) continue;
      const p = await deps.stripe.get(`/prices/${id}`) as {
        active?: boolean; type?: string; unit_amount?: number | null; currency?: string;
        recurring?: { interval?: string; interval_count?: number } | null;
      };
      // Show a price only if Stripe confirms it is what the slot claims: active, recurring, monthly.
      if (p.active !== true || p.type !== 'recurring' || p.recurring?.interval !== 'month' || (p.recurring?.interval_count ?? 1) !== 1
        || typeof p.unit_amount !== 'number' || typeof p.currency !== 'string') {
        console.error(`billing: configured ${plan} price is not an active monthly recurring price`);
        continue;
      }
      out.push({ plan, interval: 'month', amount: p.unit_amount, currency: p.currency.toUpperCase() });
    }
    priceCache = { at: now(), prices: out };
    return out;
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const body = await req.json().catch(() => null) as { action?: unknown; plan?: unknown } | null;
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
            max_active_reminders: l.max_active_reminders, max_upcoming_events: l.max_upcoming_events,
            max_ai_connections: l.max_ai_connections, byoai_captures_per_hour: l.byoai_captures_per_hour,
            byoai_captures_per_day: l.byoai_captures_per_day, byoai_max_capture_seconds: l.byoai_max_capture_seconds,
          }])),
        });
      }

      if (!['checkout', 'change_plan', 'portal', 'invoices'].includes(String(action))) return fail(req, 400, 'invalid_action', 'Unknown action');

      const user = await deps.getUser(req);
      if (!user) return fail(req, 401, 'unauthorized', 'Sign in required');
      if (!deps.stripe) return fail(req, 503, 'billing_not_configured', 'Payments are not set up yet');
      const stripe = deps.stripe;
      const row = await deps.store.subscriptionFor(user.id);

      if (action === 'invoices') {
        if (!row?.stripe_customer_id) return json(req, 200, { invoices: [] });
        const list = await stripe.get(`/invoices?customer=${encodeURIComponent(row.stripe_customer_id)}&limit=12`) as { data?: Record<string, unknown>[] };
        const invoices: InvoiceSummary[] = (list.data ?? [])
          // Defence in depth: only this user's customer, whatever Stripe returns.
          .filter((i) => i.customer === row.stripe_customer_id && typeof i.id === 'string' && typeof i.created === 'number')
          .map((i) => ({
            id: String(i.id),
            number: typeof i.number === 'string' ? i.number : null,
            created: new Date(Number(i.created) * 1000).toISOString(),
            amount: typeof i.amount_paid === 'number' && i.status === 'paid' ? i.amount_paid : (typeof i.amount_due === 'number' ? i.amount_due : 0),
            currency: typeof i.currency === 'string' ? i.currency.toUpperCase() : '',
            status: typeof i.status === 'string' ? i.status : null,
            url: safeInvoiceUrl(i.hosted_invoice_url),
          }));
        return json(req, 200, { invoices });
      }

      const origin = req.headers.get('origin');
      if (!origin || !isOriginAllowed(origin, deps.allowedOrigins)) return fail(req, 403, 'origin_not_allowed', 'Unknown origin');

      if (action === 'portal') {
        if (!row?.stripe_customer_id) return fail(req, 409, 'no_billing_account', 'No subscription to manage yet');
        const session = await stripe.post('/billing_portal/sessions', {
          customer: row.stripe_customer_id,
          return_url: `${origin}/app/billing`,
        });
        return json(req, 200, { url: session.url });
      }

      // checkout / change_plan: the browser names a plan; the server picks its price.
      const plan = body?.plan;
      if (!isPaidPlan(plan)) return fail(req, 400, 'invalid_plan', 'Choose Plus or Pro');
      const priceId = deps.prices[plan];
      if (!priceId) return fail(req, 400, 'invalid_plan', 'This plan is not available yet');

      if (action === 'change_plan') {
        if (!row?.stripe_customer_id || !row.stripe_subscription_id || !hasLiveSubscription(row, now())) {
          return fail(req, 409, 'no_subscription', 'Subscribe first');
        }
        const sub = await stripe.get(`/subscriptions/${row.stripe_subscription_id}`) as {
          customer?: unknown; items?: { data?: { id?: unknown; price?: { id?: unknown } }[] };
        };
        const items = sub.items?.data ?? [];
        if (sub.customer !== row.stripe_customer_id || items.length !== 1 || typeof items[0].id !== 'string') {
          console.error('billing: change_plan refused (subscription does not match the user or has several items)');
          return fail(req, 409, 'no_subscription', 'This subscription cannot be changed here');
        }
        if (items[0].price?.id === priceId) return fail(req, 409, 'already_on_plan', 'You are already on this plan');
        const session = await stripe.post('/billing_portal/sessions', {
          customer: row.stripe_customer_id,
          return_url: `${origin}/app/billing`,
          flow_data: {
            type: 'subscription_update_confirm',
            subscription_update_confirm: {
              subscription: row.stripe_subscription_id,
              items: [{ id: items[0].id, price: priceId, quantity: 1 }],
            },
            after_completion: { type: 'redirect', redirect: { return_url: `${origin}/app/billing?changed=1` } },
          },
        });
        return json(req, 200, { url: session.url });
      }

      // checkout (new subscribers only)
      if (hasLiveSubscription(row, now())) return fail(req, 409, 'already_subscribed', 'Change or manage your existing subscription instead');

      let customerId = row?.stripe_customer_id ?? null;
      if (!customerId) {
        const customer = await stripe.post('/customers', {
          ...(user.email ? { email: user.email } : {}),
          metadata: { supabase_user_id: user.id },
        }, `mvl-customer-${user.id}`);
        customerId = String(customer.id);
        await deps.store.linkCustomer(user.id, customerId);
      }

      const session = await stripe.post('/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/pricing?checkout=cancelled`,
        subscription_data: { metadata: { supabase_user_id: user.id } },
        metadata: { supabase_user_id: user.id },
      }, `mvl-checkout-${user.id}-${plan}-${Math.floor(now() / 60_000)}`);
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
