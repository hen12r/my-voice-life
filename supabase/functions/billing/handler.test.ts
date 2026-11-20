// Billing tests (run with: npm run test:functions). Stripe and the database are recording fakes.
// Proves: checkout/portal need a signed-in user and an allow-listed origin; the price comes from
// the server's configuration (never the browser); customers are created once and linked to the
// right user; existing subscribers are sent to the portal; nothing here grants Premium.
import { type StripeClient, StripeApiError } from '../_shared/stripe.ts';
import { type BillingDeps, createBillingHandler, type SubscriptionRow } from './handler.ts';

function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

const ORIGIN = 'https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app';
const USER = { id: '3c30d720-400f-4956-9c11-ed5dec974d1c', email: 'owner@example.test' };
const LIMITS = [
  { plan: 'free', ai_captures_per_month: 7, audio_minutes_per_month: 15, max_capture_seconds: 120 },
  { plan: 'premium', ai_captures_per_month: 300, audio_minutes_per_month: 600, max_capture_seconds: 300 },
];
const PRICE_OBJ = (interval: string, amount: number, over: Record<string, unknown> = {}) =>
  ({ id: `price_${interval}`, active: true, type: 'recurring', unit_amount: amount, currency: 'eur', recurring: { interval, interval_count: 1 }, ...over });

interface Call { method: string; path: string; params?: Record<string, unknown>; idem?: string }

function setup(opts: { row?: SubscriptionRow | null; user?: typeof USER | null; noStripe?: boolean; stripeFails?: boolean; prices?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const links: [string, string][] = [];
  const stripe: StripeClient = {
    get(path) {
      calls.push({ method: 'GET', path });
      if (path === '/prices/price_Monthly') return Promise.resolve(opts.prices?.month as Record<string, unknown> ?? PRICE_OBJ('month', 499));
      if (path === '/prices/price_Yearly') return Promise.resolve(opts.prices?.year as Record<string, unknown> ?? PRICE_OBJ('year', 3999));
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
    post(path, params, idem) {
      calls.push({ method: 'POST', path, params, idem });
      if (opts.stripeFails) return Promise.reject(new StripeApiError(400, 'invalid_request_error', 'resource_missing', 'No such price'));
      if (path === '/customers') return Promise.resolve({ id: 'cus_New1' });
      if (path === '/checkout/sessions') return Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
      if (path === '/billing_portal/sessions') return Promise.resolve({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    },
    del() { return Promise.reject(new Error('billing must not delete anything')); },
  };
  const deps: BillingDeps = {
    stripe: opts.noStripe ? undefined : stripe,
    mode: opts.noStripe ? null : 'test',
    prices: { month: 'price_Monthly', year: 'price_Yearly' },
    allowedOrigins: ['http://localhost:3000', 'https://my-voice-life-*-henry7.vercel.app'],
    getUser: () => Promise.resolve(opts.user === undefined ? USER : opts.user),
    store: {
      subscriptionFor: () => Promise.resolve(opts.row === undefined ? { plan: 'free', status: 'active', current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null } : opts.row),
      linkCustomer: (u, c) => { links.push([u, c]); return Promise.resolve(); },
      planLimits: () => Promise.resolve(LIMITS),
    },
    now: () => Date.parse('2026-11-20T12:00:00Z'),
  };
  return { handle: createBillingHandler(deps), calls, links };
}

async function call(handle: (r: Request) => Promise<Response>, body: unknown, origin: string | null = ORIGIN) {
  const res = await handle(new Request('https://x.supabase.co/functions/v1/billing', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

// ---------------------------------------------------------------- prices

Deno.test('prices: public, amounts read from Stripe, limits read from the database', async () => {
  const { handle } = setup({ user: null });
  const r = await call(handle, { action: 'prices' });
  assertEq(r.status, 200, 'status');
  assertEq(r.body, {
    configured: true, test_mode: true,
    prices: [{ interval: 'month', amount: 499, currency: 'EUR' }, { interval: 'year', amount: 3999, currency: 'EUR' }],
    limits: {
      free: { ai_captures_per_month: 7, audio_minutes_per_month: 15, max_capture_seconds: 120 },
      premium: { ai_captures_per_month: 300, audio_minutes_per_month: 600, max_capture_seconds: 300 },
    },
  }, 'payload');
});

Deno.test('prices: a misconfigured price (inactive, one-off, or wrong interval) is not shown', async () => {
  const { handle } = setup({ prices: { month: PRICE_OBJ('month', 499, { active: false }), year: PRICE_OBJ('month', 3999) } });
  const r = await call(handle, { action: 'prices' });
  assertEq(r.body.prices, [], 'nothing shown');
  assertEq(r.body.configured, false, 'reported as not configured');
});

Deno.test('prices: cached for 5 minutes (no Stripe call per page view)', async () => {
  const { handle, calls } = setup();
  await call(handle, { action: 'prices' });
  await call(handle, { action: 'prices' });
  assertEq(calls.filter((c) => c.method === 'GET').length, 2, 'two price lookups total, not four');
});

Deno.test('prices: without Stripe, plans and limits still show, with no invented price', async () => {
  const { handle } = setup({ noStripe: true });
  const r = await call(handle, { action: 'prices' });
  assertEq([r.body.configured, r.body.test_mode, r.body.prices], [false, false, []], 'not configured');
  assertEq(r.body.limits.free.ai_captures_per_month, 7, 'limits still shown');
});

// ---------------------------------------------------------------- checkout

Deno.test('checkout: new customer created once (idempotency key), linked to the signed-in user, server-side price', async () => {
  const { handle, calls, links } = setup();
  // The browser tries to choose its own price and URLs: all ignored.
  const r = await call(handle, { action: 'checkout', interval: 'month', price: 'price_Cheap', success_url: 'https://evil.example', customer: 'cus_Victim' });
  assertEq(r.status, 200, 'status');
  assertEq(r.body.url, 'https://checkout.stripe.com/c/pay/cs_test_1', 'Checkout URL returned');
  const cust = calls.find((c) => c.path === '/customers')!;
  assertEq(cust.idem, `mvl-customer-${USER.id}`, 'idempotent customer creation');
  assertEq(cust.params, { email: USER.email, metadata: { supabase_user_id: USER.id } }, 'customer params');
  assertEq(links, [[USER.id, 'cus_New1']], 'customer linked to this user in the database');
  const cs = calls.find((c) => c.path === '/checkout/sessions')!.params!;
  assertEq(cs.mode, 'subscription', 'subscription mode');
  assertEq(cs.customer, 'cus_New1', 'our customer, not the one the browser sent');
  assertEq(cs.client_reference_id, USER.id, 'client_reference_id = user id');
  assertEq(cs.line_items, [{ price: 'price_Monthly', quantity: 1 }], 'configured price, not the browser one');
  assertEq(cs.success_url, `${ORIGIN}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`, 'success URL from the allowed origin');
  assertEq(cs.cancel_url, `${ORIGIN}/pricing?checkout=cancelled`, 'cancel URL from the allowed origin');
  assertEq(cs.subscription_data, { metadata: { supabase_user_id: USER.id } }, 'subscription metadata');
});

Deno.test('checkout: an existing customer is reused (no duplicate customers)', async () => {
  const { handle, calls, links } = setup({ row: { plan: 'free', status: 'canceled', current_period_end: null, stripe_customer_id: 'cus_Old', stripe_subscription_id: 'sub_Old' } });
  const r = await call(handle, { action: 'checkout', interval: 'year' });
  assertEq(r.status, 200, 'status');
  assertEq(calls.some((c) => c.path === '/customers'), false, 'no new customer');
  assertEq(links.length, 0, 'no re-link');
  assertEq(calls.find((c) => c.path === '/checkout/sessions')!.params!.customer, 'cus_Old', 'existing customer');
  assertEq(calls.find((c) => c.path === '/checkout/sessions')!.params!.line_items, [{ price: 'price_Yearly', quantity: 1 }], 'yearly price');
});

Deno.test('checkout: requires sign-in', async () => {
  const { handle, calls } = setup({ user: null });
  assertEq((await call(handle, { action: 'checkout', interval: 'month' })).status, 401, 'status');
  assertEq(calls.length, 0, 'no Stripe call');
});

Deno.test('checkout: unknown origin refused (no open redirect)', async () => {
  const { handle, calls } = setup();
  assertEq((await call(handle, { action: 'checkout', interval: 'month' }, 'https://evil.example')).status, 403, 'evil origin');
  assertEq((await call(handle, { action: 'checkout', interval: 'month' }, null)).status, 403, 'no origin');
  assertEq(calls.length, 0, 'no Stripe call');
});

Deno.test('checkout: invalid billing period refused', async () => {
  const { handle } = setup();
  assertEq((await call(handle, { action: 'checkout', interval: 'week' })).body.error.code, 'invalid_plan', 'week');
  assertEq((await call(handle, { action: 'checkout' })).body.error.code, 'invalid_plan', 'missing');
});

Deno.test('checkout: an existing live subscription is sent to the portal instead (no double billing)', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    const { handle, calls } = setup({ row: { plan: 'premium', status, current_period_end: '2026-12-20T00:00:00Z', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } });
    const r = await call(handle, { action: 'checkout', interval: 'month' });
    assertEq([r.status, r.body.error.code], [409, 'already_subscribed'], status);
    assertEq(calls.length, 0, `${status}: no Stripe call`);
  }
});

Deno.test('checkout: not configured → 503, never a fake checkout', async () => {
  const { handle } = setup({ noStripe: true });
  assertEq((await call(handle, { action: 'checkout', interval: 'month' })).body.error.code, 'billing_not_configured', 'code');
});

Deno.test('checkout: Stripe errors become a generic 502 without details or keys', async () => {
  const { handle } = setup({ stripeFails: true });
  const r = await call(handle, { action: 'checkout', interval: 'month' });
  assertEq([r.status, r.body.error.code], [502, 'billing_provider_error'], 'generic error');
  assert(!r.text.includes('sk_') && !r.text.includes('No such price'), 'no provider details leaked');
});

// ---------------------------------------------------------------- portal

Deno.test('portal: opens the Customer Portal for the user\'s own customer, returning to Settings', async () => {
  const { handle, calls } = setup({ row: { plan: 'premium', status: 'active', current_period_end: null, stripe_customer_id: 'cus_Mine', stripe_subscription_id: 'sub_1' } });
  const r = await call(handle, { action: 'portal', customer: 'cus_Victim' });
  assertEq([r.status, r.body.url], [200, 'https://billing.stripe.com/p/session/test_1'], 'portal URL');
  assertEq(calls[0].params, { customer: 'cus_Mine', return_url: `${ORIGIN}/app/settings` }, 'own customer, safe return URL');
});

Deno.test('portal: without a billing account → 409; signed-out → 401', async () => {
  assertEq((await call(setup().handle, { action: 'portal' })).body.error.code, 'no_billing_account', 'no customer');
  assertEq((await call(setup({ user: null }).handle, { action: 'portal' })).status, 401, 'signed out');
});

Deno.test('unknown actions and methods are refused', async () => {
  const { handle } = setup();
  assertEq((await call(handle, { action: 'grant_premium' })).body.error.code, 'invalid_action', 'unknown action');
  assertEq((await handle(new Request('https://x/f', { method: 'GET' }))).status, 405, 'GET');
});
