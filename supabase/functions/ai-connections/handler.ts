// POST /functions/v1/ai-connections — the signed-in user's own AI provider key (BYOAI).
//   { "action": "status" }                                   → { connections: [{ provider, hint, status, validated_at }] }
//   { "action": "connect", "provider": "openai", "api_key" } → validates the key with OpenAI, stores it in Vault
//   { "action": "disconnect", "provider": "openai" }         → deletes the key (and its Vault secret)
// The key travels once, browser → this function, over TLS. It is validated with a free OpenAI call
// (GET /v1/models), stored ONLY through the service-role RPC mvl_byoai_set_key (Supabase Vault),
// and NEVER returned, logged, or sent anywhere except api.openai.com. Users see a 4-character hint.
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { normaliseApiKey } from '../_shared/secrets.ts';

export interface ConnectionRow { provider: string; key_hint: string; status: string; validated_at: string | null }
export interface ConnectionsStore {
  status(userId: string): Promise<ConnectionRow[]>;
  setKey(userId: string, provider: 'openai', key: string, hint: string): Promise<void>;
  deleteKey(userId: string, provider: 'openai'): Promise<boolean>;
}
export interface ConnectionsDeps {
  getUser(req: Request): Promise<{ id: string } | null>;
  store: ConnectionsStore;
  fetch: typeof fetch;
  /** Models the key's project must be allowed to use (process-voice needs both). */
  requiredModels: string[];
  now?: () => number;
}

export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60_000;

/** Last 4 characters, for display only (never enough to use the key). */
export function keyHint(key: string): string {
  return key.slice(-4);
}

export function createConnectionsHandler(deps: ConnectionsDeps) {
  const now = deps.now ?? Date.now;
  // Per-user throttle on connect attempts, so this endpoint can't be used to test many keys.
  // In-memory (per function instance): a speed bump, not a guarantee; auth is required anyway.
  const attempts = new Map<string, number[]>();
  function tooManyAttempts(userId: string): boolean {
    const t = now();
    const recent = (attempts.get(userId) ?? []).filter((x) => t - x < WINDOW_MS);
    recent.push(t);
    attempts.set(userId, recent);
    return recent.length > MAX_ATTEMPTS;
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const user = await deps.getUser(req);
    if (!user) return fail(req, 401, 'unauthorized', 'Sign in required');
    const body = await req.json().catch(() => null) as { action?: unknown; provider?: unknown; api_key?: unknown } | null;
    const action = body?.action;

    try {
      if (action === 'status') {
        const rows = await deps.store.status(user.id);
        return json(req, 200, { connections: rows.map((r) => ({ provider: r.provider, hint: r.key_hint, status: r.status, validated_at: r.validated_at })) });
      }
      if (action !== 'connect' && action !== 'disconnect') return fail(req, 400, 'invalid_action', 'Unknown action');
      if (body?.provider !== 'openai') return fail(req, 400, 'unsupported_provider', 'Only OpenAI is supported');

      if (action === 'disconnect') {
        await deps.store.deleteKey(user.id, 'openai');
        return json(req, 200, { connected: false, provider: 'openai' });
      }

      // connect
      if (tooManyAttempts(user.id)) return fail(req, 429, 'too_many_attempts', 'Too many attempts. Try again in a few minutes.');
      const raw = typeof body?.api_key === 'string' && body.api_key.length <= 400 ? body.api_key : null;
      const { key } = normaliseApiKey(raw);
      if (!key || key.length < 20 || !/^[A-Za-z0-9_-]+$/.test(key)) return fail(req, 400, 'invalid_key', 'This does not look like an OpenAI API key');

      let res: Response;
      try {
        res = await deps.fetch(OPENAI_MODELS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      } catch {
        return fail(req, 502, 'provider_unavailable', 'OpenAI could not be reached. Try again.');
      }
      if (res.status === 401) return fail(req, 400, 'key_rejected', 'OpenAI rejected this key');
      if (res.status === 403) return fail(req, 400, 'key_no_permission', 'This key is not allowed to list models');
      if (!res.ok) {
        console.warn(`ai-connections: OpenAI returned ${res.status} while validating a key`);
        return fail(req, 502, 'provider_unavailable', 'OpenAI could not validate the key right now');
      }
      const list = await res.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
      const ids = new Set((list?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string'));
      const missing = deps.requiredModels.filter((m) => !ids.has(m));
      if (missing.length) return json(req, 400, { error: { code: 'key_missing_models', message: 'This key\'s project cannot use the required models', missing } });

      const hint = keyHint(key);
      try {
        await deps.store.setKey(user.id, 'openai', key, hint);
      } catch (err) {
        if (err instanceof Error && err.message.includes('PLAN_LIMIT_AI_CONNECTIONS')) return fail(req, 403, 'plan_limit_ai_connections', 'Your plan does not allow another AI connection');
        throw err;
      }
      return json(req, 200, { connected: true, provider: 'openai', hint });
    } catch (err) {
      // Never log the request body or the error detail: it could contain the key.
      console.error(`ai-connections: ${String(action)} failed (${err instanceof Error ? err.name : 'error'})`);
      return fail(req, 500, 'connection_failed', 'Something went wrong');
    }
  };
}
