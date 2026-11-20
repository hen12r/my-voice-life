// POST /functions/v1/delete-account — permanently deletes the caller's account.
// All user data is removed by ON DELETE CASCADE from auth.users.
// Requires body { "confirm": "DELETE" } to avoid accidental calls.
// If the user has a Stripe subscription that could still bill them, it is cancelled at Stripe
// FIRST; if that isn't possible the account is NOT deleted (a deleted user must never keep paying).
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { BILLABLE_STATUSES, type StripeClient, StripeApiError } from '../_shared/stripe.ts';

export interface DeleteDeps {
  getUser(req: Request): Promise<{ id: string } | null>;
  subscriptionFor(userId: string): Promise<{ status: string; stripe_subscription_id: string | null } | null>;
  stripe: StripeClient | undefined;
  deleteUser(userId: string): Promise<void>;
}

export function createDeleteHandler(deps: DeleteDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const user = await deps.getUser(req);
    if (!user) return fail(req, 401, 'unauthorized', 'Sign in required');
    const body = await req.json().catch(() => null);
    if (body?.confirm !== 'DELETE') return fail(req, 400, 'confirmation_required', 'Send { "confirm": "DELETE" }');

    const sub = await deps.subscriptionFor(user.id).catch(() => undefined);
    if (sub === undefined) return fail(req, 500, 'delete_failed', 'Could not check the subscription');
    if (sub?.stripe_subscription_id && BILLABLE_STATUSES.includes(sub.status)) {
      if (!deps.stripe) return fail(req, 409, 'active_subscription', 'Cancel your subscription before deleting your account');
      try {
        await deps.stripe.del(`/subscriptions/${sub.stripe_subscription_id}`);
      } catch (err) {
        // Already gone at Stripe is fine; anything else stops the deletion.
        if (!(err instanceof StripeApiError && err.status === 404)) {
          console.error(`delete-account: could not cancel subscription (${err instanceof StripeApiError ? `${err.status} ${err.code ?? ''}` : 'error'})`);
          return fail(req, 502, 'subscription_cancel_failed', 'Could not cancel your subscription; your account was not deleted');
        }
      }
    }

    try {
      await deps.deleteUser(user.id);
    } catch {
      console.error('delete-account failed');
      return fail(req, 500, 'delete_failed', 'Could not delete account');
    }
    return json(req, 200, { deleted: true });
  };
}
