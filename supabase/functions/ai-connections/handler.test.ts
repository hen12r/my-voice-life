// ai-connections tests (run with: npm run test:functions). OpenAI and the database are recording
// fakes (SIMULATED). Keys below are placeholders, never real keys. Proves: sign-in required; the key
// is validated with OpenAI BEFORE it is stored; it is sent only to api.openai.com; it is never
// returned or logged; rejections are specific; connect attempts are throttled.
import { createConnectionsHandler, type ConnectionRow, keyHint, OPENAI_MODELS_URL } from './handler.ts';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

const KEY = 'sk-proj-PLACEHOLDERconnect0000abcd';
const MODELS = { data: [{ id: 'gpt-transcribe' }, { id: 'gpt-6-luna' }, { id: 'other-model' }] };

function setup(opts: { user?: { id: string } | null; openai?: Response | 'network'; setKeyError?: string; rows?: ConnectionRow[] } = {}) {
  const fetches: { url: string; auth: string | null }[] = [];
  const stored: { user: string; provider: string; key: string; hint: string }[] = [];
  const deleted: string[] = [];
  let t = 1_800_000_000_000;
  const handle = createConnectionsHandler({
    getUser: () => Promise.resolve(opts.user === undefined ? { id: 'user-1' } : opts.user),
    store: {
      status: () => Promise.resolve(opts.rows ?? []),
      setKey: (user, provider, key, hint) => {
        if (opts.setKeyError) return Promise.reject(new Error(opts.setKeyError));
        stored.push({ user, provider, key, hint }); return Promise.resolve();
      },
      deleteKey: (user) => { deleted.push(user); return Promise.resolve(true); },
    },
    fetch: (input, init) => {
      fetches.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      if (opts.openai === 'network') return Promise.reject(new TypeError('network'));
      return Promise.resolve(opts.openai?.clone() ?? new Response(JSON.stringify(MODELS), { status: 200 }));
    },
    requiredModels: ['gpt-transcribe', 'gpt-6-luna'],
    now: () => (t += 1000),
  });
  return { handle, fetches, stored, deleted };
}

async function post(handle: (r: Request) => Promise<Response>, body: unknown) {
  const res = await handle(new Request('https://x.supabase.co/functions/v1/ai-connections', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', Origin: 'http://localhost:3000' },
  }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.error = grab; console.warn = grab; console.log = grab;
  try { return { result: await fn(), logs: lines.join('\n') }; } finally { Object.assign(console, orig); }
}

Deno.test('connect: validated with OpenAI first, then stored; only a hint comes back', async () => {
  const s = setup();
  const { result: r, logs } = await captureLogs(() => post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY }));
  assertEq(r.status, 200, 'status');
  assertEq(r.body, { connected: true, provider: 'openai', hint: 'abcd' }, 'only the 4-character hint is returned');
  assertEq(s.fetches, [{ url: OPENAI_MODELS_URL, auth: `Bearer ${KEY}` }], 'one validation call, to api.openai.com only');
  assertEq(s.stored, [{ user: 'user-1', provider: 'openai', key: KEY, hint: 'abcd' }], 'stored for the signed-in user');
  assert(!r.text.includes(KEY) && !logs.includes(KEY) && !logs.includes('PLACEHOLDERconnect'), 'the key is never returned or logged');
});

Deno.test('connect: pasted with spaces, a line break or quotes → cleaned before validation', async () => {
  const s = setup();
  assertEq((await post(s.handle, { action: 'connect', provider: 'openai', api_key: `  "${KEY}"\n` })).status, 200, 'status');
  assertEq(s.stored[0].key, KEY, 'clean key stored');
});

Deno.test('connect: malformed keys are refused without calling OpenAI', async () => {
  for (const bad of ['', 'short', 'sk-proj has spaces inside it xxxxxx', `${KEY}<script>`, 'x'.repeat(401), 42, null]) {
    const s = setup();
    const r = await post(s.handle, { action: 'connect', provider: 'openai', api_key: bad });
    assertEq([r.status, r.body.error.code], [400, 'invalid_key'], String(bad).slice(0, 20));
    assertEq(s.fetches.length + s.stored.length, 0, 'no OpenAI call, nothing stored');
  }
});

Deno.test('connect: rejected key, missing permission, missing models, OpenAI down → nothing stored', async () => {
  const cases: [Response | 'network', number, string][] = [
    [new Response('{"error":{"message":"Incorrect API key provided: sk-proj-****abcd"}}', { status: 401 }), 400, 'key_rejected'],
    [new Response('{}', { status: 403 }), 400, 'key_no_permission'],
    [new Response(JSON.stringify({ data: [{ id: 'gpt-transcribe' }] }), { status: 200 }), 400, 'key_missing_models'],
    [new Response('{}', { status: 500 }), 502, 'provider_unavailable'],
    ['network', 502, 'provider_unavailable'],
  ];
  for (const [openai, status, codeName] of cases) {
    const s = setup({ openai });
    const { result: r, logs } = await captureLogs(() => post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY }));
    assertEq([r.status, r.body.error.code], [status, codeName], codeName);
    assertEq(s.stored.length, 0, `${codeName}: nothing stored`);
    assert(!r.text.includes(KEY) && !logs.includes(KEY) && !r.text.includes('****abcd'), `${codeName}: no key or fragment leaked`);
  }
  const s = setup({ openai: new Response(JSON.stringify({ data: [{ id: 'gpt-transcribe' }] }), { status: 200 }) });
  assertEq((await post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY })).body.error.missing, ['gpt-6-luna'], 'the missing model is named');
});

Deno.test('connect: plan limit on connections → 403 plan_limit_ai_connections', async () => {
  const s = setup({ setKeyError: 'PLAN_LIMIT_AI_CONNECTIONS' });
  const r = await post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY });
  assertEq([r.status, r.body.error.code], [403, 'plan_limit_ai_connections'], 'refused');
});

Deno.test('connect: storage failure → generic 500 that never echoes the key', async () => {
  const s = setup({ setKeyError: `insert failed for ${KEY}` });
  const { result: r, logs } = await captureLogs(() => post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY }));
  assertEq([r.status, r.body.error.code], [500, 'connection_failed'], 'generic');
  assert(!r.text.includes(KEY) && !logs.includes(KEY), 'no key in the response or logs');
});

Deno.test('connect: more than 5 attempts in 10 minutes → too_many_attempts (no OpenAI call)', async () => {
  const s = setup({ openai: new Response('{}', { status: 401 }) });
  for (let i = 0; i < 5; i++) assertEq((await post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY })).body.error.code, 'key_rejected', `attempt ${i + 1}`);
  const r = await post(s.handle, { action: 'connect', provider: 'openai', api_key: KEY });
  assertEq([r.status, r.body.error.code], [429, 'too_many_attempts'], '6th attempt throttled');
  assertEq(s.fetches.length, 5, 'the throttled attempt did not reach OpenAI');
});

Deno.test('status and disconnect: own connections only; disconnect deletes for the signed-in user', async () => {
  const s = setup({ rows: [{ provider: 'openai', key_hint: 'abcd', status: 'active', validated_at: '2026-11-21T10:00:00Z' }] });
  const st = await post(s.handle, { action: 'status' });
  assertEq(st.body, { connections: [{ provider: 'openai', hint: 'abcd', status: 'active', validated_at: '2026-11-21T10:00:00Z' }] }, 'status');
  const d = await post(s.handle, { action: 'disconnect', provider: 'openai', user_id: 'someone-else' });
  assertEq([d.status, d.body.connected], [200, false], 'disconnected');
  assertEq(s.deleted, ['user-1'], 'the signed-in user, not the id in the body');
});

Deno.test('refusals: signed out, unknown action or provider, GET', async () => {
  assertEq((await post(setup({ user: null }).handle, { action: 'status' })).status, 401, 'signed out');
  const s = setup();
  assertEq((await post(s.handle, { action: 'export_key' })).body.error.code, 'invalid_action', 'no action returns a key');
  assertEq((await post(s.handle, { action: 'connect', provider: 'anthropic', api_key: KEY })).body.error.code, 'unsupported_provider', 'provider');
  assertEq((await s.handle(new Request('https://x/f', { method: 'GET' }))).status, 405, 'GET');
});

Deno.test('keyHint: last 4 characters only', () => {
  assertEq(keyHint(KEY), 'abcd', 'hint');
});
