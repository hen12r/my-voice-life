// Billing tests (run with: npm run test:functions). Stripe and the database are recording fakes
// (SIMULATED, not Stripe test mode). Proves: checkout/change_plan/portal need a signed-in user and
// an allow-listed origin; the price always comes from the server's configuration (the browser can
// only name a plan); customers are created once and linked to the right user; existing
// subscribers change plan through Stripe's portal (no second subscription); invoices are the
// user's own with Stripe-hosted links only; nothing here grants a plan.
import { type StripeClient, StripeApiError } from '../_shared/stripe.ts';
import { type BillingDeps, createBillingHandler, safeInvoiceUrl, type SubscriptionRow } from './handler.ts';

function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

const ORIGIN = 'https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app';
const USER = { id: '3c30d720-400f-4956-9c11-ed5dec974d1c', email: 'owner@example.test' };
const LIMIT = (plan: string, over: Record<string, unknown> = {}) => ({
  plan, max_active_reminders: null, max_upcoming_events: null, max_ai_connections: 1,
  byoai_captures_per_hour: 20, byoai_captures_per_day: 60, byoai_max_capture_seconds: 300, ...over,
});
const LIMITS = [
  LIMIT('free', { max_active_reminders: 10, max_upcoming_events: 20, byoai_captures_per_hour: 5, byoai_captures_per_day: 10, byoai_max_capture_seconds: 120 }),
  LIMIT('plus'),
  LIMIT('pro', { byoai_captures_per_hour: 40, byoai_captures_per_day: 200, byoai_max_capture_seconds: 600 }),
];
const PRICE_OBJ = (id: string, amount: number, over: Record<string, unknown> = {}) =>
  ({ id, active: true, type: 'recurring', unit_amount: amount, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, ...over });
const LIVE_ROW = (over: Partial<SubscriptionRow> = {}): SubscriptionRow =>
  ({ plan: 'plus', status: 'active', current_period_end: '2026-12-20T00:00:00Z', stripe_customer_id: 'cus_Mine', stripe_subscription_id: 'sub_Mine', ...over });
const SUB_OBJ = (price = 'price_Plus', over: Record<string, unknown> = {}) =>
  ({ id: 'sub_Mine', customer: 'cus_Mine', items: { data: [{ id: 'si_Mine', price: { id: price } }] }, ...over });

interface Call { method: string; path: string; params?: Record<string, unknown>; idem?: string }

function setup(opts: {
  row?: SubscriptionRow | null; user?: typeof USER | null; noStripe?: boolean; stripeFails?: boolean;
  prices?: Record<string, unknown>; sub?: Record<string, unknown>; invoices?: Record<string, unknown>[]; noPro?: boolean;
} = {}) {
  const calls: Call[] = [];
  const links: [string, string][] = [];
  const stripe: StripeClient = {
    get(path) {
      calls.push({ method: 'GET', path });
      if (path === '/prices/price_Plus') return Promise.resolve(opts.prices?.plus as Record<string, unknown> ?? PRICE_OBJ('price_Plus', 499));
      if (path === '/prices/price_Pro') return Promise.resolve(opts.prices?.pro as Record<string, unknown> ?? PRICE_OBJ('price_Pro', 999));
      if (path === '/subscriptions/sub_Mine') return Promise.resolve(opts.sub ?? SUB_OBJ());
      if (path.startsWith('/invoices?')) return Promise.resolve({ data: opts.invoices ?? [] });
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
    prices: { plus: 'price_Plus', pro: opts.noPro ? null : 'price_Pro' },
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

Deno.test('prices: public; Plus and Pro monthly amounts read from Stripe; limits read from the database', async () => {
  const { handle } = setup({ user: null });
  const r = await call(handle, { action: 'prices' });
  assertEq(r.status, 200, 'status');
  assertEq([r.body.configured, r.body.test_mode], [true, true], 'configured, test mode');
  assertEq(r.body.prices, [
    { plan: 'plus', interval: 'month', amount: 499, currency: 'USD' },
    { plan: 'pro', interval: 'month', amount: 999, currency: 'USD' },
  ], 'prices');
  assertEq(Object.keys(r.body.limits), ['free', 'plus', 'pro'], 'three plans');
  assertEq(r.body.limits.free.max_active_reminders, 10, 'free reminder cap');
  assertEq(r.body.limits.pro.byoai_max_capture_seconds, 600, 'pro recording length');
  assert(!r.text.includes('ai_captures_per_month'), 'no included-AI allowance is advertised (BYOAI)');
});

Deno.test('prices: a misconfigured price (inactive, one-off, or yearly) is not shown', async () => {
  for (const bad of [{ active: false }, { type: 'one_time' }, { recurring: { interval: 'year', interval_count: 1 } }, { recurring: { interval: 'month', interval_count: 3 } }]) {
    const { handle } = setup({ prices: { plus: PRICE_OBJ('price_Plus', 499, bad), pro: PRICE_OBJ('price_Pro', 999, bad) } });
    const r = await call(handle, { action: 'prices' });
    assertEq([r.body.prices, r.body.configured], [[], false], JSON.stringify(bad));
  }
});

Deno.test('prices: Pro not configured → only Plus is offered', async () => {
  const r = await call(setup({ noPro: true }).handle, { action: 'prices' });
  assertEq(r.body.prices.map((p: { plan: string }) => p.plan), ['plus'], 'plus only');
});

Deno.test('prices: cached for 5 minutes (no Stripe call per page view)', async () => {
  const { handle, calls } = setup();
  await call(handle, { action: 'prices' });
  await call(handle, { action: 'prices' });
  assertEq(calls.filter((c) => c.method === 'GET').length, 2, 'two price lookups total, not four');
});

Deno.test('prices: without Stripe, plans and limits still show, with no invented price', async () => {
  const r = await call(setup({ noStripe: true }).handle, { action: 'prices' });
  assertEq([r.body.configured, r.body.test_mode, r.body.prices], [false, false, []], 'not configured');
  assertEq(r.body.limits.free.max_upcoming_events, 20, 'limits still shown');
});

// ---------------------------------------------------------------- checkout

Deno.test('checkout: new customer created once, linked to the signed-in user, server-side price for the named plan', async () => {
  const { handle, calls, links } = setup();
  // The browser tries to choose its own price, amount, customer and URLs: all ignored.
  const r = await call(handle, { action: 'checkout', plan: 'pro', price: 'price_Cheap', amount: 1, success_url: 'https://evil.example', customer: 'cus_Victim' });
  assertEq(r.status, 200, 'status');
  assertEq(r.body.url, 'https://checkout.stripe.com/c/pay/cs_test_1', 'Checkout URL returned');
  const cust = calls.find((c) => c.path === '/customers')!;
  assertEq(cust.idem, `mvl-customer-${USER.id}`, 'idempotent customer creation');
  assertEq(cust.params, { email: USER.email, metadata: { supabase_user_id: USER.id } }, 'customer params');
  assertEq(links, [[USER.id, 'cus_New1']], 'customer linked to this user in the database');
  const csCall = calls.find((c) => c.path === '/checkout/sessions')!;
  const cs = csCall.params!;
  assertEq(cs.mode, 'subscription', 'subscription mode');
  assertEq(cs.customer, 'cus_New1', 'our customer, not the one the browser sent');
  assertEq(cs.client_reference_id, USER.id, 'client_reference_id = user id');
  assertEq(cs.line_items, [{ price: 'price_Pro', quantity: 1 }], 'configured Pro price, not the browser one');
  assertEq(cs.success_url, `${ORIGIN}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`, 'success URL from the allowed origin');
  assertEq(cs.cancel_url, `${ORIGIN}/pricing?checkout=cancelled`, 'cancel URL from the allowed origin');
  assertEq(cs.subscription_data, { metadata: { supabase_user_id: USER.id } }, 'subscription metadata');
  assert(csCall.idem?.startsWith(`mvl-checkout-${USER.id}-pro-`), 'checkout session is idempotent (a double click opens one session)');
});

Deno.test('checkout: a double click within the same minute reuses the same idempotency key', async () => {
  const { handle, calls } = setup();
  await call(handle, { action: 'checkout', plan: 'plus' });
  await call(handle, { action: 'checkout', plan: 'plus' });
  const keys = calls.filter((c) => c.path === '/checkout/sessions').map((c) => c.idem);
  assertEq(keys.length === 2 && keys[0] === keys[1], true, 'same key, so Stripe returns the same session');
});

Deno.test('checkout: an existing customer is reused (no duplicate customers)', async () => {
  const { handle, calls, links } = setup({ row: { plan: 'free', status: 'canceled', current_period_end: null, stripe_customer_id: 'cus_Old', stripe_subscription_id: 'sub_Old' } });
  const r = await call(handle, { action: 'checkout', plan: 'plus' });
  assertEq(r.status, 200, 'status');
  assertEq(calls.some((c) => c.path === '/customers'), false, 'no new customer');
  assertEq(links.length, 0, 'no re-link');
  assertEq(calls.find((c) => c.path === '/checkout/sessions')!.params!.customer, 'cus_Old', 'existing customer');
});

Deno.test('checkout: requires sign-in', async () => {
  const { handle, calls } = setup({ user: null });
  assertEq((await call(handle, { action: 'checkout', plan: 'plus' })).status, 401, 'status');
  assertEq(calls.length, 0, 'no Stripe call');
});

Deno.test('checkout: unknown origin refused (no open redirect)', async () => {
  const { handle, calls } = setup();
  assertEq((await call(handle, { action: 'checkout', plan: 'plus' }, 'https://evil.example')).status, 403, 'evil origin');
  assertEq((await call(handle, { action: 'checkout', plan: 'plus' }, null)).status, 403, 'no origin');
  assertEq(calls.length, 0, 'no Stripe call');
});

Deno.test('checkout: invalid or unconfigured plan refused', async () => {
  const { handle } = setup({ noPro: true });
  for (const plan of ['free', 'premium', 'enterprise', '', undefined, 'PRO']) {
    assertEq((await call(handle, { action: 'checkout', plan })).body.error.code, 'invalid_plan', String(plan));
  }
  assertEq((await call(handle, { action: 'checkout', plan: 'pro' })).body.error.code, 'invalid_plan', 'pro has no price yet');
});

Deno.test('checkout: an existing live subscription must change plan instead (no double billing)', async () => {
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    const { handle, calls } = setup({ row: LIVE_ROW({ status }) });
    const r = await call(handle, { action: 'checkout', plan: 'pro' });
    assertEq([r.status, r.body.error.code], [409, 'already_subscribed'], status);
    assertEq(calls.length, 0, `${status}: no Stripe call`);
  }
});

Deno.test('checkout: not configured → 503, never a fake checkout', async () => {
  assertEq((await call(setup({ noStripe: true }).handle, { action: 'checkout', plan: 'plus' })).body.error.code, 'billing_not_configured', 'code');
});

Deno.test('checkout: Stripe errors become a generic 502 without details or keys', async () => {
  const r = await call(setup({ stripeFails: true }).handle, { action: 'checkout', plan: 'plus' });
  assertEq([r.status, r.body.error.code], [502, 'billing_provider_error'], 'generic error');
  assert(!r.text.includes('sk_') && !r.text.includes('No such price'), 'no provider details leaked');
});

// ---------------------------------------------------------------- change plan (upgrade / downgrade)

Deno.test('change_plan: upgrade Plus → Pro opens Stripe\'s confirm page for the user\'s own subscription item', async () => {
  const { handle, calls } = setup({ row: LIVE_ROW(), sub: SUB_OBJ('price_Plus') });
  const r = await call(handle, { action: 'change_plan', plan: 'pro', subscription: 'sub_Victim', price: 'price_Cheap' });
  assertEq([r.status, r.body.url], [200, 'https://billing.stripe.com/p/session/test_1'], 'portal URL');
  assertEq(calls[0], { method: 'GET', path: '/subscriptions/sub_Mine' }, 're-reads the user\'s own subscription from Stripe');
  const p = calls[1].params!;
  assertEq(p.customer, 'cus_Mine', 'own customer');
  assertEq(p.return_url, `${ORIGIN}/app/billing`, 'safe return URL');
  assertEq(p.flow_data, {
    type: 'subscription_update_confirm',
    subscription_update_confirm: { subscription: 'sub_Mine', items: [{ id: 'si_Mine', price: 'price_Pro', quantity: 1 }] },
    after_completion: { type: 'redirect', redirect: { return_url: `${ORIGIN}/app/billing?changed=1` } },
  }, 'flow data uses the server price and the user\'s own item');
});

Deno.test('change_plan: downgrade Pro → Plus', async () => {
  const { handle, calls } = setup({ row: LIVE_ROW({ plan: 'pro' }), sub: SUB_OBJ('price_Pro') });
  assertEq((await call(handle, { action: 'change_plan', plan: 'plus' })).status, 200, 'status');
  assertEq((calls[1].params!.flow_data as { subscription_update_confirm: { items: { price: string }[] } }).subscription_update_confirm.items[0].price, 'price_Plus', 'plus price');
});

Deno.test('change_plan: refusals (no subscription, same plan, mismatched or multi-item subscription)', async () => {
  assertEq((await call(setup().handle, { action: 'change_plan', plan: 'pro' })).body.error.code, 'no_subscription', 'free user');
  assertEq((await call(setup({ row: LIVE_ROW({ status: 'canceled' }) }).handle, { action: 'change_plan', plan: 'pro' })).body.error.code, 'no_subscription', 'canceled');
  assertEq((await call(setup({ row: LIVE_ROW(), sub: SUB_OBJ('price_Plus') }).handle, { action: 'change_plan', plan: 'plus' })).body.error.code, 'already_on_plan', 'same plan');
  assertEq((await call(setup({ row: LIVE_ROW(), sub: SUB_OBJ('price_Plus', { customer: 'cus_Someone' }) }).handle, { action: 'change_plan', plan: 'pro' })).body.error.code, 'no_subscription', 'subscription of another customer');
  const two = SUB_OBJ('price_Plus', { items: { data: [{ id: 'si_1', price: { id: 'price_Plus' } }, { id: 'si_2', price: { id: 'price_X' } }] } });
  assertEq((await call(setup({ row: LIVE_ROW(), sub: two }).handle, { action: 'change_plan', plan: 'pro' })).body.error.code, 'no_subscription', 'several items');
  assertEq((await call(setup({ row: LIVE_ROW() }).handle, { action: 'change_plan', plan: 'pro' }, 'https://evil.example')).status, 403, 'evil origin');
  assertEq((await call(setup({ row: LIVE_ROW(), user: null }).handle, { action: 'change_plan', plan: 'pro' })).status, 401, 'signed out');
});

// ---------------------------------------------------------------- portal

Deno.test('portal: opens the Customer Portal for the user\'s own customer, returning to Billing', async () => {
  const { handle, calls } = setup({ row: LIVE_ROW() });
  const r = await call(handle, { action: 'portal', customer: 'cus_Victim' });
  assertEq([r.status, r.body.url], [200, 'https://billing.stripe.com/p/session/test_1'], 'portal URL');
  assertEq(calls[0].params, { customer: 'cus_Mine', return_url: `${ORIGIN}/app/billing` }, 'own customer, safe return URL');
});

Deno.test('portal: without a billing account → 409; signed-out → 401', async () => {
  assertEq((await call(setup().handle, { action: 'portal' })).body.error.code, 'no_billing_account', 'no customer');
  assertEq((await call(setup({ user: null }).handle, { action: 'portal' })).status, 401, 'signed out');
});

// ---------------------------------------------------------------- invoices (billing history)

Deno.test('invoices: the user\'s own invoices only, with Stripe-hosted links only', async () => {
  const invoices = [
    { id: 'in_1', customer: 'cus_Mine', number: 'MVL-0001', created: 1_795_000_000, amount_paid: 499, amount_due: 499, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/test_1' },
    { id: 'in_2', customer: 'cus_Mine', number: null, created: 1_797_000_000, amount_paid: 0, amount_due: 999, currency: 'usd', status: 'open', hosted_invoice_url: 'https://evil.example/fake-invoice' },
    { id: 'in_3', customer: 'cus_Someone', number: 'X', created: 1_797_000_000, amount_paid: 1, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://invoice.stripe.com/x' },
  ];
  const { handle, calls } = setup({ row: LIVE_ROW(), invoices });
  const r = await call(handle, { action: 'invoices', customer: 'cus_Someone' });
  assertEq(r.status, 200, 'status');
  assertEq(calls[0].path, '/invoices?customer=cus_Mine&limit=12', 'asks Stripe for the user\'s own customer only');
  assertEq(r.body.invoices.map((i: { id: string }) => i.id), ['in_1', 'in_2'], 'another customer\'s invoice is dropped');
  assertEq(r.body.invoices[0], { id: 'in_1', number: 'MVL-0001', created: new Date(1_795_000_000 * 1000).toISOString(), amount: 499, currency: 'USD', status: 'paid', url: 'https://invoice.stripe.com/i/acct_1/test_1' }, 'paid invoice');
  assertEq([r.body.invoices[1].amount, r.body.invoices[1].url], [999, null], 'open invoice shows the amount due; non-Stripe link removed');
});

Deno.test('invoices: no billing account → empty list; signed-out → 401', async () => {
  const { handle, calls } = setup();
  assertEq((await call(handle, { action: 'invoices' })).body, { invoices: [] }, 'empty');
  assertEq(calls.length, 0, 'no Stripe call');
  assertEq((await call(setup({ user: null }).handle, { action: 'invoices' })).status, 401, 'signed out');
});

Deno.test('safeInvoiceUrl: only https Stripe hosts', () => {
  assertEq(safeInvoiceUrl('https://invoice.stripe.com/i/x'), 'https://invoice.stripe.com/i/x', 'invoice host');
  assertEq(safeInvoiceUrl('https://pay.stripe.com/invoice/x'), 'https://pay.stripe.com/invoice/x', 'pay host');
  for (const bad of ['http://invoice.stripe.com/x', 'https://invoice.stripe.com.evil.example/x', 'javascript:alert(1)', 42, null]) {
    assertEq(safeInvoiceUrl(bad), null, String(bad));
  }
});

Deno.test('unknown actions and methods are refused', async () => {
  const { handle } = setup();
  assertEq((await call(handle, { action: 'grant_pro' })).body.error.code, 'invalid_action', 'unknown action');
  assertEq((await handle(new Request('https://x/f', { method: 'GET' }))).status, 405, 'GET');
});
