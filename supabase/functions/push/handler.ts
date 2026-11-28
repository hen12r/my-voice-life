// POST /functions/v1/push — the signed-in user's own notification devices.
//   { "action": "config" }                       → { public_key } (the VAPID public key the browser subscribes with)
//   { "action": "test", "title", "body" }        → sends one test notification to the caller's own devices
// Subscribing/unsubscribing a device is done by the app through the database (mvl_push_subscribe /
// mvl_push_unsubscribe, RLS-checked); this function never accepts an endpoint from the browser.
// If the VAPID keys are not configured, it answers 503 push_not_configured (the app shows "not available yet").
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { type PushResult, type PushSubscriptionRow, type RawKeyPair, b64urlEncode, sendPush } from '../_shared/webpush.ts';

export interface PushDeps {
  getUser(req: Request): Promise<{ id: string } | null>;
  vapid: { keys: RawKeyPair; subject: string } | null;
  store: {
    targets(userId: string): Promise<PushSubscriptionRow[]>;
    record(id: string, ok: boolean, gone: boolean): Promise<void>;
  };
  fetch: typeof fetch;
  now?: () => number;
}

const MAX_TESTS = 5;
const WINDOW_MS = 10 * 60_000;
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function createPushHandler(deps: PushDeps) {
  const now = deps.now ?? Date.now;
  const tests = new Map<string, number[]>(); // per-instance speed bump on test sends
  const throttled = (userId: string) => {
    const t = now();
    const recent = (tests.get(userId) ?? []).filter((x) => t - x < WINDOW_MS);
    recent.push(t); tests.set(userId, recent);
    return recent.length > MAX_TESTS;
  };

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const user = await deps.getUser(req);
    if (!user) return fail(req, 401, 'unauthorized', 'Sign in required');
    if (!deps.vapid) return fail(req, 503, 'push_not_configured', 'Notifications are not configured on the server');
    const body = await req.json().catch(() => null) as { action?: unknown; title?: unknown; body?: unknown } | null;

    if (body?.action === 'config') return json(req, 200, { public_key: b64urlEncode(deps.vapid.keys.publicKey) });
    if (body?.action !== 'test') return fail(req, 400, 'invalid_action', 'Unknown action');

    if (throttled(user.id)) return fail(req, 429, 'too_many_attempts', 'Too many tests. Try again in a few minutes.');
    const targets = await deps.store.targets(user.id);
    if (targets.length === 0) return fail(req, 400, 'no_devices', 'Notifications are not on for any device');
    const payload = { kind: 'test', title: clip(body.title, 80) || 'My Voice Life', body: clip(body.body, 160) };
    const results: PushResult[] = [];
    for (const sub of targets) {
      const r = await sendPush(sub, payload, deps.vapid, deps.fetch).catch(() => ({ id: sub.id, ok: false, gone: false, status: 0 }));
      await deps.store.record(r.id, r.ok, r.gone).catch(() => undefined);
      results.push(r);
    }
    console.log(`push test: devices=${targets.length} ok=${results.filter((r) => r.ok).length} removed=${results.filter((r) => r.gone).length}`);
    return json(req, 200, { sent: results.filter((r) => r.ok).length, removed: results.filter((r) => r.gone).length });
  };
}
