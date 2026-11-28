// POST /functions/v1/send-reminders — wiring only; the logic is in handler.ts (tested in handler.test.ts).
// Deploy WITHOUT JWT verification (verify_jwt = false): it is called by the database scheduler and
// protected by the CRON_SECRET header instead. Secrets: CRON_SECRET (≥ 32 random characters, also
// stored in Vault for the scheduler), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { parseVapidKeys } from '../_shared/webpush.ts';
import { createSendHandler, type DueReminder, type Target } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const keys = parseVapidKeys(Deno.env.get('VAPID_PUBLIC_KEY'), Deno.env.get('VAPID_PRIVATE_KEY'));
const subject = Deno.env.get('VAPID_SUBJECT')?.trim();

Deno.serve(createSendHandler({
  cronSecret: Deno.env.get('CRON_SECRET'),
  vapid: keys && subject ? { keys, subject } : null,
  db: {
    async claimDue(limit) {
      const { data, error } = await admin.rpc('mvl_push_claim_due', { p_limit: limit });
      if (error) throw new Error('claim failed');
      return (data ?? []) as DueReminder[];
    },
    async targets(ownerIds) {
      const { data, error } = await admin.rpc('mvl_push_targets', { p_users: ownerIds });
      if (error) throw new Error('targets failed');
      return (data ?? []) as Target[];
    },
    async record(id, ok, gone) {
      await admin.rpc('mvl_push_record_result', { p_subscription: id, p_ok: ok, p_gone: gone });
    },
  },
  fetch: (...a) => fetch(...a),
}));
