// POST /functions/v1/process-voice — entry point. All logic lives in handler.ts (tested in
// handler.test.ts); this file only wires real dependencies from the Edge Function environment.
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { createHandler } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

Deno.serve(createHandler({
  geminiApiKey: Deno.env.get('GEMINI_API_KEY'),
  geminiModel: Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash',
  alertWebhookUrl: Deno.env.get('ALERT_WEBHOOK_URL') || undefined,
  // Acts as the calling user so every query goes through RLS.
  userClient: (req) => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  }),
  // Service role: ONLY for the accounting RPCs (never exposed to the browser).
  adminClient: () => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }),
  fetch: (...args) => fetch(...args),
}));
