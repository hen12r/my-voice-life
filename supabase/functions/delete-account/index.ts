// POST /functions/v1/delete-account — wiring only; the logic is in handler.ts (tested in handler.test.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { readBillingEnv } from '../_shared/billing-env.ts';
import { createDeleteHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
// The service-role key exists only inside the Edge Function runtime, never in the browser.
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(createDeleteHandler({
  async getUser(req) {
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false },
    });
    const { data, error } = await userClient.auth.getUser();
    return error || !data?.user ? null : { id: data.user.id };
  },
  async subscriptionFor(userId) {
    const { data, error } = await admin.from('subscriptions').select('status, stripe_subscription_id').eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  stripe: readBillingEnv().stripe,
  async deleteUser(userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  },
}));
