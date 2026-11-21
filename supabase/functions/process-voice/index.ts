// POST /functions/v1/process-voice — entry point. All logic lives in handler.ts (tested in
// handler.test.ts); this file only wires real dependencies from the Edge Function environment.
// Secrets (Supabase Edge Function secrets, never in the browser or the repository):
//   OPENAI_API_KEY             optional platform key, for staff testing only (ai_mode = admins_only).
//                              Users bring their OWN key (BYOAI, stored in Supabase Vault); without
//                              one they get ai_key_required.
//   OPENAI_TRANSCRIBE_MODEL    optional, default gpt-transcribe
//   OPENAI_TEXT_MODEL          optional, default gpt-6-luna
//   ALERT_WEBHOOK_URL          optional budget-alert webhook (no user data is sent)
// Changing a model requires a matching row in mvl_price_book, otherwise AI fails closed.
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { normaliseApiKey } from '../_shared/secrets.ts';
import { DEFAULT_TEXT_MODEL, DEFAULT_TRANSCRIBE_MODEL } from '../_shared/transcription.ts';
import { createHandler } from './handler.ts';
import { createOpenAiProvider } from './provider.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// Read once at startup. Pasting mistakes (spaces, a line break, quotes) are corrected; warnings
// describe the problem without ever including the key. The key itself is never logged.
const { key: OPENAI_API_KEY, warnings: keyWarnings } = normaliseApiKey(Deno.env.get('OPENAI_API_KEY'));
for (const w of keyWarnings) console.warn(`process-voice: ${w}`);
if (!OPENAI_API_KEY) console.warn('process-voice: OPENAI_API_KEY (platform key) is not configured; only users with their own key can use AI.');
const TRANSCRIBE_MODEL = Deno.env.get('OPENAI_TRANSCRIBE_MODEL') || DEFAULT_TRANSCRIBE_MODEL;
const TEXT_MODEL = Deno.env.get('OPENAI_TEXT_MODEL') || DEFAULT_TEXT_MODEL;

Deno.serve(createHandler({
  provider: OPENAI_API_KEY
    ? createOpenAiProvider({
      apiKey: OPENAI_API_KEY, transcribeModel: TRANSCRIBE_MODEL, textModel: TEXT_MODEL, fetch: (...args) => fetch(...args),
    })
    : undefined,
  // BYOAI: a provider for the user's own key (read from Vault by the handler, used for one request).
  userProvider: (apiKey) => createOpenAiProvider({
    apiKey: normaliseApiKey(apiKey).key ?? '', transcribeModel: TRANSCRIBE_MODEL, textModel: TEXT_MODEL, fetch: (...args) => fetch(...args),
  }),
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
