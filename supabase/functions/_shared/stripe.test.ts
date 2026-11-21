import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  billingModeAllowed, checkoutUserFromEvent, createStripeClient, formEncode, isConfiguredPrice, isPaidPlan, parseEvent, parsePriceConfig, planForPrice,
  secretKeyMode, signStripePayloadForTest, StripeApiError, subscriptionIdFromEvent, subscriptionSnapshot, verifyStripeSignature,
} from './stripe';

const SECRET = 'whsec_test_secret_for_unit_tests';
const BODY = '{"id":"evt_1","object":"event","type":"invoice.paid"}';
const NOW = 1_800_000_000;

/** Independent oracle: Node's crypto, not the Web Crypto code under test. */
const nodeSig = (body: string, secret: string, t: number) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('webhook signature verification', () => {
  it('accepts a signature computed the way Stripe documents it (checked against Node crypto)', async () => {
    const header = `t=${NOW},v1=${nodeSig(BODY, SECRET, NOW)}`;
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true, timestamp: NOW });
    expect(await signStripePayloadForTest(BODY, SECRET, NOW)).toBe(header);
  });
  it('accepts when one of several v1 signatures matches (secret rotation)', async () => {
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${nodeSig(BODY, SECRET, NOW)},v0=ignored`;
    expect((await verifyStripeSignature(BODY, header, SECRET, NOW)).ok).toBe(true);
  });
  it('rejects a modified body', async () => {
    const header = `t=${NOW},v1=${nodeSig(BODY, SECRET, NOW)}`;
    expect(await verifyStripeSignature(BODY.replace('invoice.paid', 'invoice.PAID'), header, SECRET, NOW)).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
  it('rejects a signature made with another secret', async () => {
    const header = `t=${NOW},v1=${nodeSig(BODY, 'whsec_attacker', NOW)}`;
    expect((await verifyStripeSignature(BODY, header, SECRET, NOW)).ok).toBe(false);
  });
  it('rejects old or future timestamps (replay protection, 5-minute tolerance)', async () => {
    const old = NOW - 301;
    expect(await verifyStripeSignature(BODY, `t=${old},v1=${nodeSig(BODY, SECRET, old)}`, SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    const future = NOW + 301;
    expect((await verifyStripeSignature(BODY, `t=${future},v1=${nodeSig(BODY, SECRET, future)}`, SECRET, NOW)).ok).toBe(false);
    const edge = NOW - 300;
    expect((await verifyStripeSignature(BODY, `t=${edge},v1=${nodeSig(BODY, SECRET, edge)}`, SECRET, NOW)).ok).toBe(true);
  });
  it('rejects a timestamp swapped onto a valid signature', async () => {
    const header = `t=${NOW + 1},v1=${nodeSig(BODY, SECRET, NOW)}`;
    expect((await verifyStripeSignature(BODY, header, SECRET, NOW)).ok).toBe(false);
  });
  it('rejects missing or malformed headers, and a missing secret', async () => {
    expect(await verifyStripeSignature(BODY, null, SECRET, NOW)).toEqual({ ok: false, reason: 'missing_header' });
    expect(await verifyStripeSignature(BODY, 'garbage', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyStripeSignature(BODY, `t=${NOW}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyStripeSignature(BODY, `v1=${nodeSig(BODY, SECRET, NOW)}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyStripeSignature(BODY, `t=${NOW},v0=${nodeSig(BODY, SECRET, NOW)}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${nodeSig(BODY, SECRET, NOW)}`, undefined, NOW)).toEqual({ ok: false, reason: 'no_secret' });
    expect(await verifyStripeSignature(BODY, `t=${NOW},v1=${nodeSig(BODY, SECRET, NOW)}`, '', NOW)).toEqual({ ok: false, reason: 'no_secret' });
  });
});

describe('test-mode guard', () => {
  it('classifies keys', () => {
    expect(secretKeyMode('sk_test_abc123')).toBe('test');
    expect(secretKeyMode('rk_test_abc123')).toBe('test');
    expect(secretKeyMode('sk_live_abc123')).toBe('live');
    expect(secretKeyMode('pk_test_abc123')).toBe('invalid'); // publishable keys never belong on the server
    expect(secretKeyMode('')).toBe('invalid');
    expect(secretKeyMode(undefined)).toBe('invalid');
  });
  it('refuses live keys unless live mode is explicitly approved', () => {
    expect(billingModeAllowed('sk_test_abc', undefined)).toEqual({ ok: true, mode: 'test' });
    expect(billingModeAllowed('sk_live_abc', undefined)).toEqual({ ok: false, reason: 'live_mode_not_approved' });
    expect(billingModeAllowed('sk_live_abc', 'yes')).toEqual({ ok: false, reason: 'live_mode_not_approved' });
    expect(billingModeAllowed('sk_live_abc', 'true')).toEqual({ ok: true, mode: 'live' });
    expect(billingModeAllowed(undefined, 'true')).toEqual({ ok: false, reason: 'missing_or_invalid_key' });
  });
});

const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, created: NOW, livemode: false, data: { object } });

describe('events', () => {
  it('parses only well-formed events', () => {
    expect(parseEvent(JSON.stringify(ev('invoice.paid', {}))))?.toBeTruthy();
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent(JSON.stringify({ ...ev('invoice.paid', {}), id: 'xyz' }))).toBeNull();
    expect(parseEvent(JSON.stringify({ ...ev('invoice.paid', {}), livemode: 'false' }))).toBeNull();
    expect(parseEvent(JSON.stringify({ id: 'evt_1', type: 'x', created: 1, livemode: false }))).toBeNull();
  });
  it('finds the subscription for each handled event type', () => {
    expect(subscriptionIdFromEvent(ev('checkout.session.completed', { mode: 'subscription', subscription: 'sub_A' }))).toBe('sub_A');
    expect(subscriptionIdFromEvent(ev('checkout.session.completed', { mode: 'payment', subscription: null }))).toBeNull();
    expect(subscriptionIdFromEvent(ev('customer.subscription.updated', { id: 'sub_B' }))).toBe('sub_B');
    expect(subscriptionIdFromEvent(ev('customer.subscription.deleted', { id: 'sub_B' }))).toBe('sub_B');
    // basil+ invoices
    expect(subscriptionIdFromEvent(ev('invoice.paid', { parent: { subscription_details: { subscription: 'sub_C' } } }))).toBe('sub_C');
    // older API versions
    expect(subscriptionIdFromEvent(ev('invoice.payment_failed', { subscription: 'sub_D' }))).toBe('sub_D');
    expect(subscriptionIdFromEvent(ev('invoice.paid', { subscription: { id: 'sub_E' } }))).toBe('sub_E');
    expect(subscriptionIdFromEvent(ev('invoice.paid', {}))).toBeNull(); // one-off invoice
    expect(subscriptionIdFromEvent(ev('customer.subscription.updated', { id: 'not-a-sub' }))).toBeNull();
  });
  it('reads the checkout user only from client_reference_id, and only if it is a UUID', () => {
    const uid = '3c30d720-400f-4956-9c11-ed5dec974d1c';
    expect(checkoutUserFromEvent(ev('checkout.session.completed', { client_reference_id: uid }))).toBe(uid);
    expect(checkoutUserFromEvent(ev('checkout.session.completed', { client_reference_id: 'admin' }))).toBeNull();
    expect(checkoutUserFromEvent(ev('invoice.paid', { client_reference_id: uid }))).toBeNull();
  });
});

const SUB = {
  id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', cancel_at_period_end: false, livemode: false,
  metadata: { supabase_user_id: '3c30d720-400f-4956-9c11-ed5dec974d1c' },
  items: { data: [{ id: 'si_1', current_period_end: 1_800_000_000, price: { id: 'price_M', recurring: { interval: 'month', interval_count: 1 } } }] },
};

describe('subscription snapshots', () => {
  it('reads the basil+ shape (period end on the item)', () => {
    expect(subscriptionSnapshot(SUB)).toEqual({
      id: 'sub_1', customer: 'cus_1', status: 'active', priceId: 'price_M', interval: 'month',
      periodEnd: new Date(1_800_000_000 * 1000).toISOString(), cancelAtPeriodEnd: false, livemode: false,
      metadataUser: '3c30d720-400f-4956-9c11-ed5dec974d1c',
    });
  });
  it('falls back to the pre-basil shape (period end on the subscription)', () => {
    const old = { ...SUB, current_period_end: 1_700_000_000, items: { data: [{ id: 'si_1', price: SUB.items.data[0].price }] } };
    expect(subscriptionSnapshot(old).periodEnd).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
  it('accepts an expanded customer object', () => {
    expect(subscriptionSnapshot({ ...SUB, customer: { id: 'cus_9' } }).customer).toBe('cus_9');
  });
  it('refuses anything unexpected instead of guessing', () => {
    expect(() => subscriptionSnapshot({ ...SUB, status: 'superactive' })).toThrow();
    expect(() => subscriptionSnapshot({ ...SUB, customer: null })).toThrow();
    expect(() => subscriptionSnapshot({ ...SUB, items: { data: [] } })).toThrow();
    expect(() => subscriptionSnapshot({ ...SUB, items: { data: [SUB.items.data[0], SUB.items.data[0]] } })).toThrow();
    expect(() => subscriptionSnapshot({ ...SUB, items: { data: [{ ...SUB.items.data[0], price: { id: 'price_M', recurring: { interval: 'month', interval_count: 3 } } }] } })).toThrow();
  });
  it('ignores a metadata user id that is not a UUID', () => {
    expect(subscriptionSnapshot({ ...SUB, metadata: { supabase_user_id: "'; drop table" } }).metadataUser).toBeNull();
  });
});

describe('configuration', () => {
  it('accepts only well-formed price ids', () => {
    expect(parsePriceConfig(' price_Plus1 ', 'price_Pro1')).toEqual({ plus: 'price_Plus1', pro: 'price_Pro1' });
    expect(parsePriceConfig('prod_X', undefined)).toEqual({ plus: null, pro: null });
  });
  it('refuses the same price for both plans (the plan would be ambiguous)', () => {
    expect(parsePriceConfig('price_Same', 'price_Same')).toEqual({ plus: null, pro: null });
  });
  it('allow-lists configured prices only', () => {
    const cfg = { plus: 'price_P', pro: null };
    expect(isConfiguredPrice(cfg, 'price_P')).toBe(true);
    expect(isConfiguredPrice(cfg, 'price_Other')).toBe(false);
    expect(isConfiguredPrice(cfg, null)).toBe(false);
  });
  it('maps a price to its plan from the server allow-list only', () => {
    const cfg = { plus: 'price_P', pro: 'price_Q' };
    expect(planForPrice(cfg, 'price_P')).toBe('plus');
    expect(planForPrice(cfg, 'price_Q')).toBe('pro');
    expect(planForPrice(cfg, 'price_Unknown')).toBeNull();
    expect(planForPrice(cfg, null)).toBeNull();
    expect(planForPrice({ plus: null, pro: null }, 'price_P')).toBeNull();
  });
  it('recognises paid plan names only', () => {
    expect(isPaidPlan('plus')).toBe(true);
    expect(isPaidPlan('pro')).toBe(true);
    for (const v of ['free', 'premium', 'PRO', '', null, undefined, 1]) expect(isPaidPlan(v)).toBe(false);
  });
});

describe('REST client', () => {
  it('encodes nested parameters the way Stripe expects', () => {
    expect(formEncode({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], subscription_data: { metadata: { supabase_user_id: 'u' } }, skip: undefined }))
      .toBe('mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&subscription_data%5Bmetadata%5D%5Bsupabase_user_id%5D=u');
  });
  it('sends the key only in the Authorization header, pins the API version, and passes idempotency keys', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response('{"id":"cs_1"}')); }) as unknown as typeof fetch;
    const c = createStripeClient({ secretKey: 'sk_test_KEY', fetch: fake });
    await c.post('/checkout/sessions', { mode: 'subscription' }, 'idem-1');
    const h = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(h.get('authorization')).toBe('Bearer sk_test_KEY');
    expect(h.get('stripe-version')).toBe('2026-11-18.endive');
    expect(h.get('idempotency-key')).toBe('idem-1');
    expect(String(calls[0].init.body)).not.toContain('sk_test');
    expect(calls[0].url).not.toContain('sk_test');
  });
  it('turns Stripe errors into StripeApiError without leaking the key', async () => {
    const fake = (() => Promise.resolve(new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price' } }), { status: 404 }))) as unknown as typeof fetch;
    const c = createStripeClient({ secretKey: 'sk_test_SECRETKEY', fetch: fake });
    const err = await c.get('/prices/price_X').catch((e) => e);
    expect(err).toBeInstanceOf(StripeApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('resource_missing');
    expect(String(err.message)).not.toContain('SECRETKEY');
  });
  it('refuses odd paths', async () => {
    const c = createStripeClient({ secretKey: 'sk_test_K', fetch: (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch });
    await expect(c.get('https://evil.example/x')).rejects.toThrow('invalid Stripe path');
    await expect(c.get('/../x')).rejects.toThrow('invalid Stripe path');
  });
});
