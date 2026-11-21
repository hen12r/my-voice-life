// POST /functions/v1/stripe-webhook — wiring only; the logic is in handler.ts (tested in handler.test.ts).
// Deploy with JWT verification OFF (`verify_jwt = false`): Stripe authenticates with its signature.
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { readBillingEnv } from '../_shared/billing-env.ts';
import { createWebhookHandler } from './handler.ts';

const env = readBillingEnv();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(createWebhookHandler({
  webhookSecret: env.webhookSecret,
  stripe: env.stripe,
  mode: env.mode,
  prices: env.prices,
  store: {
    async applySubscription(args) {
      const { data, error } = await admin.rpc('mvl_billing_apply_subscription_v2', args);
      if (error) throw new Error(`apply failed: ${error.code ?? ''}`);
      return data as { outcome: string };
    },
  },
}));
