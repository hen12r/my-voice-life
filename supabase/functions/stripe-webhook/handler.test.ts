// Webhook tests (run with: npm run test:functions). Stripe's API and the database are replaced by
// recording fakes; signatures are produced exactly as Stripe documents them. Proves: only signed,
// fresh, correctly-moded events are processed; state always comes from a RE-FETCHED subscription,
// never from the event payload; and each lifecycle event maps to the right database call.
import { signStripePayloadForTest, type StripeClient, StripeApiError } from '../_shared/stripe.ts';
import { type ApplyArgs, createWebhookHandler, type WebhookDeps } from './handler.ts';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

const SECRET = 'whsec_test_webhook_secret';
const NOW = 1_800_000_000;
const USER = '3c30d720-400f-4956-9c11-ed5dec974d1c';
const PRICES = { plus: 'price_Monthly', pro: 'price_ProMonthly' };

const subscription = (over: Record<string, unknown> = {}, periodEnd = NOW + 30 * 86400, price = 'price_Monthly') => ({
  id: 'sub_123', object: 'subscription', customer: 'cus_123', status: 'active', cancel_at_period_end: false, livemode: false,
  metadata: { supabase_user_id: USER },
  items: { data: [{ id: 'si_1', current_period_end: periodEnd, price: { id: price, recurring: { interval: 'month', interval_count: 1 } } }] },
  ...over,
});

function fakeStripe(subs: Record<string, unknown> | (() => never)) {
  const gets: string[] = [];
  const client: StripeClient = {
    get(path) {
      gets.push(path);
      if (typeof subs === 'function') return Promise.resolve().then(subs);
      return Promise.resolve(subs as Record<string, unknown>);
    },
    post() { throw new Error('webhook must not create anything at Stripe'); },
    del() { throw new Error('webhook must not delete anything at Stripe'); },
  };
  return { client, gets };
}

function fakeStore(outcome = 'applied', fail = false) {
  const calls: ApplyArgs[] = [];
  return {
    calls,
    store: {
      applySubscription(args: ApplyArgs) {
        calls.push(args);
        return fail ? Promise.reject(new Error('db down')) : Promise.resolve({ outcome });
      },
    },
  };
}

function setup(opts: { sub?: Record<string, unknown> | (() => never); outcome?: string; storeFails?: boolean; mode?: 'test' | 'live' | null; secret?: string | undefined; noStripe?: boolean } = {}) {
  const stripe = fakeStripe(opts.sub ?? subscription());
  const store = fakeStore(opts.outcome, opts.storeFails);
  const deps: WebhookDeps = {
    webhookSecret: 'secret' in opts ? opts.secret : SECRET,
    stripe: opts.noStripe ? undefined : stripe.client,
    mode: opts.mode === undefined ? 'test' : opts.mode,
    prices: PRICES,
    store: store.store,
    nowSeconds: () => NOW,
  };
  return { handle: createWebhookHandler(deps), stripe, store };
}

const event = (type: string, object: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'evt_1', object: 'event', type, created: NOW - 5, livemode: false, data: { object }, ...over });

async function post(handle: (r: Request) => Promise<Response>, body: string, header?: string | null) {
  const h = header === undefined ? await signStripePayloadForTest(body, SECRET, NOW) : header;
  const res = await handle(new Request('https://x.supabase.co/functions/v1/stripe-webhook', {
    method: 'POST', body, headers: h === null ? {} : { 'Stripe-Signature': h },
  }));
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- lifecycle

Deno.test('successful checkout: verified, subscription re-fetched, linked to the user who checked out', async () => {
  const { handle, stripe, store } = setup();
  const r = await post(handle, event('checkout.session.completed', { id: 'cs_1', mode: 'subscription', subscription: 'sub_123', customer: 'cus_123', client_reference_id: USER, payment_status: 'paid' }));
  assertEq(r.status, 200, 'status');
  assertEq(r.body.outcome, 'applied', 'outcome');
  assertEq(stripe.gets, ['/subscriptions/sub_123'], 're-fetches the subscription from Stripe');
  assertEq(store.calls.length, 1, 'one database call');
  const a = store.calls[0];
  assertEq([a.p_event_id, a.p_customer, a.p_subscription, a.p_status, a.p_price_id, a.p_interval, a.p_metadata_user, a.p_plan],
    ['evt_1', 'cus_123', 'sub_123', 'active', 'price_Monthly', 'month', USER, 'plus'], 'apply arguments (plan from the price allow-list)');
  assertEq(a.p_period_end, new Date((NOW + 30 * 86400) * 1000).toISOString(), 'period end read from the subscription item');
});

Deno.test('renewal (invoice.paid, basil shape): the new period end is applied', async () => {
  const { handle, store } = setup({ sub: subscription({}, NOW + 61 * 86400) });
  const r = await post(handle, event('invoice.paid', { id: 'in_1', parent: { subscription_details: { subscription: 'sub_123' } } }));
  assertEq(r.status, 200, 'status');
  assertEq(store.calls[0].p_period_end, new Date((NOW + 61 * 86400) * 1000).toISOString(), 'extended period end');
  assertEq(store.calls[0].p_status, 'active', 'still active');
});

Deno.test('failed payment (invoice.payment_failed): past_due is applied', async () => {
  const { handle, store } = setup({ sub: subscription({ status: 'past_due' }) });
  const r = await post(handle, event('invoice.payment_failed', { id: 'in_2', subscription: 'sub_123' }));
  assertEq(r.status, 200, 'status');
  assertEq(store.calls[0].p_status, 'past_due', 'past_due applied (the database keeps the plan only during the grace period)');
  assertEq(store.calls[0].p_plan, 'plus', 'plan still sent so the grace period knows what to keep');
});

Deno.test('cancellation at period end, then deletion', async () => {
  const a = setup({ sub: subscription({ cancel_at_period_end: true }) });
  await post(a.handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq(a.store.calls[0].p_cancel_at_period_end, true, 'cancel_at_period_end applied');
  const b = setup({ sub: subscription({ status: 'canceled' }) });
  const r = await post(b.handle, event('customer.subscription.deleted', { id: 'sub_123' }));
  assertEq(r.status, 200, 'status');
  assertEq(b.store.calls[0].p_status, 'canceled', 'canceled applied');
});

Deno.test('expired first payment (incomplete_expired) is applied', async () => {
  const { handle, store } = setup({ sub: subscription({ status: 'incomplete_expired' }) });
  await post(handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq(store.calls[0].p_status, 'incomplete_expired', 'applied');
});

Deno.test('the event payload is NOT trusted: state comes from the re-fetched subscription', async () => {
  // The payload claims "active"; Stripe's API says "canceled" → canceled is applied.
  const { handle, store } = setup({ sub: subscription({ status: 'canceled' }) });
  await post(handle, event('customer.subscription.updated', { id: 'sub_123', status: 'active', customer: 'cus_ATTACKER', metadata: { supabase_user_id: 'b1000000-0000-0000-0000-000000000003' } }));
  assertEq(store.calls[0].p_status, 'canceled', 'status from Stripe API');
  assertEq(store.calls[0].p_customer, 'cus_123', 'customer from Stripe API');
  assertEq(store.calls[0].p_metadata_user, USER, 'metadata from Stripe API');
});

Deno.test('a duplicate delivery is acknowledged (the database makes it a no-op)', async () => {
  const { handle } = setup({ outcome: 'duplicate' });
  const r = await post(handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq([r.status, r.body.outcome], [200, 'duplicate'], 'acknowledged');
});

// ---------------------------------------------------------------- security

Deno.test('rejects a missing signature, without calling Stripe or the database', async () => {
  const { handle, stripe, store } = setup();
  const r = await post(handle, event('customer.subscription.updated', { id: 'sub_123' }), null);
  assertEq(r.status, 400, 'status');
  assertEq([stripe.gets.length, store.calls.length], [0, 0], 'nothing called');
});

Deno.test('rejects a forged signature (wrong secret)', async () => {
  const { handle, store } = setup();
  const body = event('customer.subscription.updated', { id: 'sub_123' });
  const r = await post(handle, body, await signStripePayloadForTest(body, 'whsec_attacker', NOW));
  assertEq(r.status, 400, 'status');
  assertEq(store.calls.length, 0, 'no database call');
});

Deno.test('rejects a tampered body (signature was for different bytes)', async () => {
  const { handle, store } = setup();
  const original = event('customer.subscription.updated', { id: 'sub_123' });
  const header = await signStripePayloadForTest(original, SECRET, NOW);
  const r = await post(handle, original.replace('sub_123', 'sub_999'), header);
  assertEq(r.status, 400, 'status');
  assertEq(store.calls.length, 0, 'no database call');
});

Deno.test('rejects a replayed old event (timestamp outside 5 minutes)', async () => {
  const { handle, store } = setup();
  const body = event('customer.subscription.updated', { id: 'sub_123' });
  const r = await post(handle, body, await signStripePayloadForTest(body, SECRET, NOW - 600));
  assertEq(r.status, 400, 'status');
  assertEq(store.calls.length, 0, 'no database call');
});

Deno.test('test mode: a LIVE event is rejected even when correctly signed', async () => {
  const { handle, stripe, store } = setup();
  const r = await post(handle, event('customer.subscription.updated', { id: 'sub_123' }, { livemode: true }));
  assertEq(r.status, 400, 'status');
  assertEq([stripe.gets.length, store.calls.length], [0, 0], 'nothing called');
});

Deno.test('a re-fetched subscription whose mode differs from the event is rejected', async () => {
  const { handle, store } = setup({ sub: subscription({ livemode: true }) });
  const r = await post(handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq(r.status, 400, 'status');
  assertEq(store.calls.length, 0, 'no database call');
});

Deno.test('never grants access for a price we did not configure; removing access still applies', async () => {
  const a = setup({ sub: subscription({}, NOW + 86400, 'price_SomethingElse') });
  const r = await post(a.handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq([r.status, r.body.ignored], [200, 'unknown_price'], 'ignored');
  assertEq(a.store.calls.length, 0, 'nothing granted');
  const b = setup({ sub: subscription({ status: 'canceled' }, NOW, 'price_SomethingElse') });
  await post(b.handle, event('customer.subscription.deleted', { id: 'sub_123' }));
  assertEq(b.store.calls[0]?.p_status, 'canceled', 'cancellation applied regardless of price');
  assertEq(b.store.calls[0]?.p_plan, null, 'no plan is sent for an unknown price (nothing can be granted)');
});

Deno.test('upgrade to Pro and downgrade to Plus: the plan follows the re-fetched price, never the event payload', async () => {
  const up = setup({ sub: subscription({}, NOW + 30 * 86400, 'price_ProMonthly') });
  // The event payload claims the Plus price; the re-fetched subscription (truth) is on Pro.
  const r = await post(up.handle, event('customer.subscription.updated', { id: 'sub_123', items: { data: [{ price: { id: 'price_Monthly' } }] } }));
  assertEq(r.status, 200, 'status');
  assertEq([up.store.calls[0].p_plan, up.store.calls[0].p_price_id], ['pro', 'price_ProMonthly'], 'upgrade applied as Pro');
  const down = setup({ sub: subscription({}, NOW + 30 * 86400, 'price_Monthly') });
  await post(down.handle, event('customer.subscription.updated', { id: 'sub_123' }));
  assertEq(down.store.calls[0].p_plan, 'plus', 'downgrade applied as Plus');
});

Deno.test('a forged plan in the event or metadata cannot change the plan', async () => {
  const { handle, store } = setup({ sub: subscription({ metadata: { supabase_user_id: USER, plan: 'pro' } }, NOW + 86400, 'price_Monthly') });
  await post(handle, event('customer.subscription.updated', { id: 'sub_123', plan: 'pro', metadata: { plan: 'pro' } }));
  assertEq(store.calls[0].p_plan, 'plus', 'plan comes only from the configured price');
});

Deno.test('not configured: 503 so Stripe retries later; nothing processed', async () => {
  const a = setup({ secret: undefined });
  assertEq((await post(a.handle, event('invoice.paid', { subscription: 'sub_123' }))).status, 503, 'no secret');
  const b = setup({ noStripe: true });
  assertEq((await post(b.handle, event('invoice.paid', { subscription: 'sub_123' }))).status, 503, 'no key');
  assertEq(a.store.calls.length + b.store.calls.length, 0, 'nothing applied');
});

Deno.test('unhandled event types and non-subscription events are acknowledged and ignored', async () => {
  const { handle, stripe, store } = setup();
  assertEq((await post(handle, event('charge.refunded', { id: 'ch_1' }))).body.ignored, 'event_type', 'unhandled type');
  assertEq((await post(handle, event('checkout.session.completed', { mode: 'payment' }))).body.ignored, 'no_subscription', 'one-off checkout');
  assertEq([stripe.gets.length, store.calls.length], [0, 0], 'nothing called');
});

Deno.test('temporary failures return 500 so Stripe retries', async () => {
  const a = setup({ sub: () => { throw new StripeApiError(500, 'api_error', null, 'Stripe down'); } });
  assertEq((await post(a.handle, event('invoice.paid', { subscription: 'sub_123' }))).status, 500, 'Stripe down');
  const b = setup({ storeFails: true });
  assertEq((await post(b.handle, event('invoice.paid', { subscription: 'sub_123' }))).status, 500, 'database down');
});

Deno.test('a subscription that no longer exists at Stripe is acknowledged, not retried forever', async () => {
  const { handle, store } = setup({ sub: () => { throw new StripeApiError(404, 'invalid_request_error', 'resource_missing', 'No such subscription'); } });
  const r = await post(handle, event('invoice.paid', { subscription: 'sub_123' }));
  assertEq([r.status, r.body.ignored], [200, 'subscription_not_found'], 'acknowledged');
  assertEq(store.calls.length, 0, 'nothing applied');
});

Deno.test('only POST is accepted; malformed JSON with a valid signature is rejected', async () => {
  const { handle } = setup();
  assertEq((await handle(new Request('https://x/f', { method: 'GET' }))).status, 405, 'GET refused');
  assertEq((await post(handle, '{not json')).status, 400, 'malformed event');
});

Deno.test('responses never echo the signing secret', async () => {
  const { handle } = setup();
  const body = event('customer.subscription.updated', { id: 'sub_123' });
  const res = await handle(new Request('https://x/f', { method: 'POST', body, headers: { 'Stripe-Signature': 'garbage' } }));
  assert(!(await res.text()).includes(SECRET), 'secret not in the response');
});
