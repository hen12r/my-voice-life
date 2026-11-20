// POST /functions/v1/billing — wiring only; the logic is in handler.ts (tested in handler.test.ts).
// Deploy with JWT verification OFF (`verify_jwt = false`): the public "prices" action must work for
// signed-out visitors; "checkout" and "portal" authenticate the user themselves below.
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { readBillingEnv } from '../_shared/billing-env.ts';
import { parseAllowedOrigins } from '../_shared/cors.ts';
import { createBillingHandler, type PlanLimitsRow, type SubscriptionRow } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const env = readBillingEnv();
// Service role: only for reading the caller's own subscription row, plan limits, and the
// service-role-only mvl_billing_link_customer() function. Never exposed to the browser.
const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(createBillingHandler({
  stripe: env.stripe,
  mode: env.mode,
  prices: env.prices,
  allowedOrigins: parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS')),
  async getUser(req) {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return null;
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false },
    });
    const { data, error } = await userClient.auth.getUser();
    return error || !data?.user ? null : { id: data.user.id, email: data.user.email ?? null };
  },
  store: {
    async subscriptionFor(userId) {
      const { data, error } = await admin.from('subscriptions')
        .select('plan, status, current_period_end, stripe_customer_id, stripe_subscription_id').eq('user_id', userId).maybeSingle();
      if (error) throw new Error(error.message);
      return data as SubscriptionRow | null;
    },
    async linkCustomer(userId, customerId) {
      const { error } = await admin.rpc('mvl_billing_link_customer', { p_user: userId, p_customer: customerId });
      if (error) throw new Error(error.message);
    },
    async planLimits() {
      const { data, error } = await admin.from('mvl_plan_limits').select('plan, ai_captures_per_month, audio_minutes_per_month, max_capture_seconds');
      if (error) throw new Error(error.message);
      return (data ?? []) as PlanLimitsRow[];
    },
  },
}));
