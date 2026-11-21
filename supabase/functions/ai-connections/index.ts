// POST /functions/v1/ai-connections — wiring only; the logic is in handler.ts (tested in handler.test.ts).
// Deploy WITH JWT verification (verify_jwt = true).
import { createClient } from 'npm:@supabase/supabase-js@2.48.1';
import { DEFAULT_TEXT_MODEL, DEFAULT_TRANSCRIBE_MODEL } from '../_shared/transcription.ts';
import { createConnectionsHandler } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
// Service role: ONLY for the BYOAI RPCs (Vault). Never exposed to the browser.
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(createConnectionsHandler({
  async getUser(req) {
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false },
    });
    const { data, error } = await userClient.auth.getUser();
    return error || !data?.user ? null : { id: data.user.id };
  },
  store: {
    async status(userId) {
      const { data, error } = await admin.from('mvl_ai_connections').select('provider, key_hint, status, validated_at').eq('user_id', userId);
      if (error) throw new Error('status failed');
      return data ?? [];
    },
    async setKey(userId, provider, key, hint) {
      const { error } = await admin.rpc('mvl_byoai_set_key', { p_user: userId, p_provider: provider, p_key: key, p_hint: hint });
      // The database message never contains the key; keep only the limit marker if present.
      if (error) throw new Error(error.message?.includes('PLAN_LIMIT_AI_CONNECTIONS') ? 'PLAN_LIMIT_AI_CONNECTIONS' : 'store failed');
    },
    async deleteKey(userId, provider) {
      const { data, error } = await admin.rpc('mvl_byoai_delete_key', { p_user: userId, p_provider: provider });
      if (error) throw new Error('delete failed');
      return Boolean(data);
    },
  },
  fetch: (...a) => fetch(...a),
  requiredModels: [Deno.env.get('OPENAI_TRANSCRIBE_MODEL') || DEFAULT_TRANSCRIBE_MODEL, Deno.env.get('OPENAI_TEXT_MODEL') || DEFAULT_TEXT_MODEL],
}));
