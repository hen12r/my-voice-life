// Stripe helpers shared by the billing and stripe-webhook Edge Functions.
// Pure TypeScript + Web Crypto only (no Deno/browser APIs), so it is unit-tested with Vitest and
// used unchanged by Deno. No Stripe SDK: requests are plain REST calls with a pinned API version.
//
// Facts verified on docs.stripe.com (2026-11-20):
//   * Webhook signatures: header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]`; the signature is
//     HMAC-SHA256(secret, `${t}.${rawBody}`), hex-encoded. Only `v1` authenticates. The libraries'
//     default tolerance is 5 minutes.
//   * Since API version 2025-03-31 (basil) the billing period lives on subscription ITEMS
//     (items.data[].current_period_end), not on the subscription.
//   * Since basil an invoice links its subscription at parent.subscription_details.subscription
//     (older versions: invoice.subscription). Both are read.
//   * Current API version in the reference: 2026-11-18.endive.

export const DEFAULT_STRIPE_API_VERSION = '2026-11-18.endive';
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_API = 'https://api.stripe.com/v1';

// ---------------------------------------------------------------- keys and mode

export type KeyMode = 'test' | 'live' | 'invalid';

/** Secret (`sk_`) or restricted (`rk_`) key mode. Publishable keys (`pk_`) are refused: they don't belong on the server. */
export function secretKeyMode(key: string | undefined): KeyMode {
  if (!key) return 'invalid';
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return 'test';
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) return 'live';
  return 'invalid';
}

/**
 * Live mode needs BOTH a live key and an explicit STRIPE_LIVE_MODE_APPROVED=true secret, so a
 * live key pasted by mistake cannot start charging real cards.
 */
export function billingModeAllowed(key: string | undefined, liveApproved: string | undefined): { ok: true; mode: 'test' | 'live' } | { ok: false; reason: string } {
  const mode = secretKeyMode(key);
  if (mode === 'invalid') return { ok: false, reason: 'missing_or_invalid_key' };
  if (mode === 'live' && liveApproved !== 'true') return { ok: false, reason: 'live_mode_not_approved' };
  return { ok: true, mode };
}

// ---------------------------------------------------------------- webhook signatures

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length lowercase hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: 'missing_header' | 'malformed_header' | 'no_secret' | 'timestamp_out_of_tolerance' | 'signature_mismatch' };

/**
 * Verifies a Stripe webhook against the RAW request body (never a re-serialised JSON object).
 * `nowSeconds` is injectable for tests.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string | undefined,
  nowSeconds: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): Promise<SignatureResult> {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing_header' };
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (timestamp === null || v1.length === 0) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return v1.some((s) => timingSafeEqualHex(s, expected)) ? { ok: true, timestamp } : { ok: false, reason: 'signature_mismatch' };
}

/** Builds a valid header the way Stripe does. Used by tests (and only by tests). */
export async function signStripePayloadForTest(rawBody: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

// ---------------------------------------------------------------- events and snapshots

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export interface StripeEventLike {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export function parseEvent(raw: string): StripeEventLike | null {
  let e: unknown;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const data = o.data as { object?: unknown } | undefined;
  if (typeof o.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(o.id) || typeof o.type !== 'string' || typeof o.created !== 'number'
    || typeof o.livemode !== 'boolean' || !data || typeof data.object !== 'object' || data.object === null) return null;
  return o as unknown as StripeEventLike;
}

const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);

/** The subscription an event is about, or null when the event isn't about a subscription. */
export function subscriptionIdFromEvent(event: StripeEventLike): string | null {
  const o = event.data.object;
  let id: string | null = null;
  if (event.type === 'checkout.session.completed') {
    if (o.mode !== 'subscription') return null;
    id = idOf(o.subscription);
  } else if (event.type.startsWith('customer.subscription.')) {
    id = idOf(o.id);
  } else if (event.type.startsWith('invoice.')) {
    const parent = o.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    id = idOf(parent?.subscription_details?.subscription) ?? idOf(o.subscription);
  }
  return id && /^sub_[A-Za-z0-9]+$/.test(id) ? id : null;
}

/** For checkout.session.completed: the app user who started checkout (we set client_reference_id). */
export function checkoutUserFromEvent(event: StripeEventLike): string | null {
  if (event.type !== 'checkout.session.completed') return null;
  const ref = event.data.object.client_reference_id;
  return typeof ref === 'string' && UUID.test(ref) ? ref : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'] as const;
export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];

export interface SubscriptionSnapshot {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  priceId: string | null;
  interval: 'month' | 'year' | null;
  periodEnd: string | null; // ISO timestamp
  cancelAtPeriodEnd: boolean;
  livemode: boolean;
  metadataUser: string | null;
}

/** Reads a Subscription object as returned by GET /v1/subscriptions/:id. Throws on anything unexpected. */
export function subscriptionSnapshot(sub: Record<string, unknown>): SubscriptionSnapshot {
  const id = idOf(sub.id), customer = idOf(sub.customer);
  if (!id || !/^sub_/.test(id) || !customer || !/^cus_/.test(customer)) throw new Error('subscription without id or customer');
  const status = sub.status as SubscriptionStatus;
  if (!SUBSCRIPTION_STATUSES.includes(status)) throw new Error(`unknown subscription status ${String(sub.status)}`);
  const items = (sub.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];
  if (items.length !== 1) throw new Error(`expected exactly one subscription item, got ${items.length}`);
  const item = items[0];
  const price = item.price as { id?: string; recurring?: { interval?: string; interval_count?: number } } | undefined;
  const interval = price?.recurring?.interval;
  if (price?.recurring?.interval_count !== undefined && price.recurring.interval_count !== 1) throw new Error('unsupported interval_count');
  // basil+: on the item; older API versions: on the subscription.
  const end = typeof item.current_period_end === 'number' ? item.current_period_end
    : typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
  const metaUser = (sub.metadata as Record<string, unknown> | undefined)?.supabase_user_id;
  return {
    id, customer, status,
    priceId: typeof price?.id === 'string' ? price.id : null,
    interval: interval === 'month' || interval === 'year' ? interval : null,
    periodEnd: end === null ? null : new Date(end * 1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    livemode: sub.livemode === true,
    metadataUser: typeof metaUser === 'string' && UUID.test(metaUser) ? metaUser : null,
  };
}

// ---------------------------------------------------------------- configuration

/** Paid plans sold through Stripe. Free has no price. */
export type PaidPlan = 'plus' | 'pro';
export const PAID_PLANS: readonly PaidPlan[] = ['plus', 'pro'];

/** One monthly recurring Stripe price per paid plan (env STRIPE_PRICE_PLUS_MONTHLY / STRIPE_PRICE_PRO_MONTHLY). */
export interface PriceConfig { plus: string | null; pro: string | null }

export function parsePriceConfig(plus: string | undefined, pro: string | undefined): PriceConfig {
  const ok = (v: string | undefined) => (v && /^price_[A-Za-z0-9]+$/.test(v.trim()) ? v.trim() : null);
  const cfg = { plus: ok(plus), pro: ok(pro) };
  // The same price for two plans would make the plan ambiguous: refuse both.
  return cfg.plus && cfg.plus === cfg.pro ? { plus: null, pro: null } : cfg;
}

/** The plan a Stripe price grants, decided ONLY from the server's allow-list. Unknown → null (grants nothing). */
export function planForPrice(cfg: PriceConfig, priceId: string | null): PaidPlan | null {
  if (!priceId) return null;
  if (priceId === cfg.plus) return 'plus';
  if (priceId === cfg.pro) return 'pro';
  return null;
}

export function isConfiguredPrice(cfg: PriceConfig, priceId: string | null): boolean {
  return planForPrice(cfg, priceId) !== null;
}

export function isPaidPlan(v: unknown): v is PaidPlan {
  return v === 'plus' || v === 'pro';
}

// ---------------------------------------------------------------- REST client

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0][b]=v. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${prefix}[${k}]`, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join('&');
}

export class StripeApiError extends Error {
  constructor(public status: number, public type: string | null, public code: string | null, message: string) { super(message); }
}

export interface StripeClient {
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
  del(path: string): Promise<Record<string, unknown>>;
}

/** Minimal Stripe REST client. The key is only ever placed in the Authorization header; errors never include it. */
export function createStripeClient(opts: { secretKey: string; apiVersion?: string; fetch: typeof fetch; timeoutMs?: number }): StripeClient {
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${opts.secretKey}`,
    'Stripe-Version': opts.apiVersion || DEFAULT_STRIPE_API_VERSION,
    ...extra,
  });
  const call = async (method: string, path: string, body?: string, idem?: string) => {
    if (!/^\/[a-z_/]+(\/[A-Za-z0-9_]+)?$/.test(path.split('?')[0])) throw new Error('invalid Stripe path');
    const res = await opts.fetch(`${STRIPE_API}${path}`, {
      method,
      headers: headers({
        ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idem ? { 'Idempotency-Key': idem } : {}),
      }),
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok || !payload) {
      const err = (payload?.error ?? {}) as { type?: string; code?: string; message?: string };
      // Stripe's error message is safe to log; it never contains the secret key.
      throw new StripeApiError(res.status, err.type ?? null, err.code ?? null, err.message ?? `Stripe request failed (${res.status})`);
    }
    return payload;
  };
  return {
    get: (path) => call('GET', path),
    post: (path, params, idem) => call('POST', path, formEncode(params), idem),
    del: (path) => call('DELETE', path),
  };
}

/** Statuses during which a subscription still exists at Stripe and could bill the customer. */
export const BILLABLE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];
