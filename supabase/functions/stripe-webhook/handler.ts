// POST /functions/v1/stripe-webhook — receives Stripe events. Deployed WITHOUT Supabase JWT
// verification (Stripe can't send one); every request is instead authenticated by its
// Stripe-Signature, checked against the raw body with the endpoint's signing secret.
//
// The event payload is never trusted for state: after verifying the signature the handler
// RE-FETCHES the subscription from Stripe's API and applies that snapshot through a service-role
// database function, which is idempotent per event id and maps the customer to the user WE linked.
// Responses: 2xx = done (or deliberately ignored), 400 = rejected (bad signature / wrong mode),
// 5xx = temporary failure, so Stripe retries.
import {
  checkoutUserFromEvent, HANDLED_EVENTS, type PaidPlan, parseEvent, planForPrice, type PriceConfig, type StripeClient, StripeApiError,
  subscriptionIdFromEvent, subscriptionSnapshot, verifyStripeSignature,
} from '../_shared/stripe.ts';

export interface ApplyArgs {
  p_event_id: string; p_event_type: string; p_event_created: string; p_livemode: boolean;
  p_customer: string; p_subscription: string; p_status: string; p_price_id: string | null; p_interval: string | null;
  p_period_end: string | null; p_cancel_at_period_end: boolean; p_metadata_user: string | null;
  /** Plan derived from the server's price allow-list (null only when access is being removed). */
  p_plan: PaidPlan | null;
}
export interface WebhookStore { applySubscription(args: ApplyArgs): Promise<{ outcome: string }> }

export interface WebhookDeps {
  webhookSecret: string | undefined;
  stripe: StripeClient | undefined;
  mode: 'test' | 'live' | null;
  prices: PriceConfig;
  store: WebhookStore;
  nowSeconds?: () => number;
}

const MAX_BODY_BYTES = 512 * 1024;
const GRANTING = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'];
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createWebhookHandler(deps: WebhookDeps) {
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!deps.webhookSecret || !deps.stripe) return reply(503, { error: 'billing_not_configured' });

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'payload_too_large' });

    const sig = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), deps.webhookSecret, nowSeconds());
    if (!sig.ok) {
      console.warn(`stripe-webhook: rejected (${sig.reason})`);
      return reply(400, { error: 'invalid_signature' });
    }
    const event = parseEvent(raw);
    if (!event) return reply(400, { error: 'invalid_event' });

    // A live event never reaches a test setup, and a test event never touches a live one.
    if (event.livemode !== (deps.mode === 'live')) {
      console.warn(`stripe-webhook: ${event.id} rejected (livemode=${event.livemode}, configured mode=${deps.mode})`);
      return reply(400, { error: 'mode_mismatch' });
    }

    if (!(HANDLED_EVENTS as readonly string[]).includes(event.type)) return reply(200, { received: true, ignored: 'event_type' });
    const subscriptionId = subscriptionIdFromEvent(event);
    if (!subscriptionId) return reply(200, { received: true, ignored: 'no_subscription' });

    try {
      let snapshot;
      try {
        snapshot = subscriptionSnapshot(await deps.stripe.get(`/subscriptions/${subscriptionId}`));
      } catch (err) {
        if (err instanceof StripeApiError && err.status === 404) return reply(200, { received: true, ignored: 'subscription_not_found' });
        throw err;
      }
      if (snapshot.livemode !== event.livemode) return reply(400, { error: 'mode_mismatch' });

      // The plan comes ONLY from our price allow-list. Never GRANT access for a price we didn't
      // configure; removing access (canceled / incomplete_expired) is always applied.
      const plan = planForPrice(deps.prices, snapshot.priceId);
      if (GRANTING.includes(snapshot.status) && !plan) {
        console.warn(`stripe-webhook: ${event.id} ignored (unconfigured price)`);
        return reply(200, { received: true, ignored: 'unknown_price' });
      }

      const result = await deps.store.applySubscription({
        p_event_id: event.id,
        p_event_type: event.type,
        p_event_created: new Date(event.created * 1000).toISOString(),
        p_livemode: event.livemode,
        p_customer: snapshot.customer,
        p_subscription: snapshot.id,
        p_status: snapshot.status,
        p_price_id: snapshot.priceId,
        p_interval: snapshot.interval,
        p_period_end: snapshot.periodEnd,
        p_cancel_at_period_end: snapshot.cancelAtPeriodEnd,
        p_metadata_user: checkoutUserFromEvent(event) ?? snapshot.metadataUser,
        p_plan: plan,
      });
      console.log(`stripe-webhook: ${event.id} ${event.type} → ${result.outcome}`);
      return reply(200, { received: true, outcome: result.outcome });
    } catch (err) {
      const detail = err instanceof StripeApiError ? `Stripe ${err.status} ${err.code ?? ''}` : err instanceof Error ? err.message : 'unknown';
      console.error(`stripe-webhook: ${event.id} failed (${detail}); Stripe will retry`);
      return reply(500, { error: 'processing_failed' });
    }
  };
}
