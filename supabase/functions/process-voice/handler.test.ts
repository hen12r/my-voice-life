// Orchestration tests for process-voice (run with: npx deno@2.1.4 test supabase/functions/process-voice/).
// Gemini and Supabase are replaced by in-memory fakes that record every call, so these tests
// prove the cost-control ORDER of operations without network access or a real key.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.48.1';
import { createHandler, type HandlerDeps } from './handler.ts';

// ---------- tiny assertion helpers (no external test libraries) ----------
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

// ---------- fakes ----------
type Json = Record<string, unknown>;
interface FetchCall { url: string; body: Json; headers: Record<string, string> }

const COUNT_OK = { totalTokens: 960, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }] }; // 30 s
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const TRANSCRIBE_OK = {
  candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: 'Tomorrow I need to call my school', language: 'en' }) }] } }],
  usageMetadata: { promptTokenCount: 1010, candidatesTokenCount: 20, thoughtsTokenCount: 0,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }, { modality: 'TEXT', tokenCount: 50 }] },
};
const EXTRACT_OK = {
  candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [
    { type: 'task', title: 'Call my school', priority: 'normal', date: tomorrow, date_confidence: 'explicit', date_text: 'tomorrow', category: 'School' },
  ] }) }] } }],
  usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 120, thoughtsTokenCount: 5 },
};
const RES_OK = {
  ok: true, reservation_id: 'res-1', plan: 'free', alert_created: false, max_output_tokens: 2048, disable_thinking: true,
  captures_used: 1, captures_limit: 7, minutes_used: 0.5, minutes_limit: 15,
};

function makeFetch(opts: { count?: Json | number; generate?: (Json | number)[] } = {}) {
  const calls: FetchCall[] = [];
  const queue = [...(opts.generate ?? [TRANSCRIBE_OK, EXTRACT_OK])];
  const respond = (v: Json | number) =>
    typeof v === 'number' ? new Response('provider error', { status: v }) : new Response(JSON.stringify(v), { status: 200 });
  const fn: typeof fetch = (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.endsWith(':countTokens')) return Promise.resolve(respond(opts.count ?? COUNT_OK));
    if (url.endsWith(':generateContent')) return Promise.resolve(respond(queue.shift() ?? 500));
    return Promise.resolve(new Response('ok')); // webhook
  };
  return { fn, calls, generateCalls: () => calls.filter((c) => c.url.endsWith(':generateContent')) };
}

function makeUser(authenticated = true) {
  const inserts: Json[] = [];
  const client = {
    auth: { getUser: () => Promise.resolve(authenticated ? { data: { user: { id: 'user-1' } }, error: null } : { data: { user: null }, error: { message: 'no session' } }) },
    from(table: string) {
      if (table === 'categories') return { select: () => Promise.resolve({ data: [{ name: 'School' }, { name: 'Work' }], error: null }) };
      if (table === 'voice_sessions') {
        return {
          insert(row: Json) {
            inserts.push(row);
            const p = Promise.resolve({ error: null });
            return Object.assign(p, { select: () => ({ single: () => Promise.resolve({ data: { id: 'session-1' }, error: null }) }) });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

function makeAdmin(reserve: Json | null = RES_OK, opts: { reserveError?: boolean; recordError?: boolean } = {}) {
  const calls: { name: string; args: Json }[] = [];
  const client = {
    rpc(name: string, args: Json) {
      calls.push({ name, args });
      if (name === 'mvl_reserve_ai_capture') return Promise.resolve(opts.reserveError ? { data: null, error: { message: 'db down' } } : { data: reserve, error: null });
      if (name === 'mvl_record_ai_call') return Promise.resolve(opts.recordError ? { data: null, error: { message: 'record failed' } } : { data: 0.001, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client: client as unknown as SupabaseClient, calls, names: () => calls.map((c) => c.name) };
}

function setup(p: { fetch?: ReturnType<typeof makeFetch>; user?: ReturnType<typeof makeUser>; admin?: ReturnType<typeof makeAdmin>; key?: string | undefined; webhook?: string } = {}) {
  const f = p.fetch ?? makeFetch();
  const u = p.user ?? makeUser();
  const a = p.admin ?? makeAdmin();
  const deps: HandlerDeps = {
    geminiApiKey: 'key' in p ? p.key : 'test-key', geminiModel: 'gemini-2.5-flash', alertWebhookUrl: p.webhook,
    userClient: () => u.client, adminClient: () => a.client, fetch: f.fn,
  };
  return { handler: createHandler(deps), f, u, a };
}

function voiceRequest(bytes = 2_000, type = 'audio/webm') {
  const form = new FormData();
  form.append('audio', new File([new Uint8Array(bytes).fill(7)], 'capture.webm', { type }));
  form.append('timezone', 'Africa/Kigali');
  form.append('language_hint', 'en');
  form.append('duration_ms', '30000');
  return new Request('http://localhost/process-voice', { method: 'POST', body: form, headers: { Authorization: 'Bearer t', Origin: 'http://localhost:3000' } });
}
function textRequest(text = 'Tomorrow I need to call my school') {
  return new Request('http://localhost/process-voice', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ text, timezone: 'Africa/Kigali', language_hint: 'en' }),
  });
}
const code = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;

// ---------- tests ----------
Deno.test('no API key: refuses before doing anything', async () => {
  const s = setup({ key: undefined });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_not_configured', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls'); assertEq(s.a.calls.length, 0, 'no accounting calls');
});

Deno.test('unauthenticated: 401, no provider or accounting calls', async () => {
  const s = setup({ user: makeUser(false) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 401, 'status');
  assertEq(s.f.calls.length, 0, 'no provider calls'); assertEq(s.a.calls.length, 0, 'no accounting calls');
});

Deno.test('refusal by usage controls: only the free countTokens call happens, never a paid call', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'quota_captures', alert_created: false }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 429, 'status'); assertEq(await code(r), 'quota_captures', 'code');
  assertEq(s.f.calls.map((c) => c.url.split(':').pop()), ['countTokens'], 'only countTokens');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture'], 'no record/finish after refusal');
  assertEq(s.a.calls[0].args.p_audio_seconds, 30, 'measured seconds passed to the reservation');
  assertEq(s.a.calls[0].args.p_user, 'user-1', 'reservation is for the authenticated user');
});

Deno.test('text input refused: zero provider calls', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'ai_test_mode', alert_created: false }) });
  const r = await s.handler(textRequest());
  assertEq(r.status, 403, 'status'); assertEq(await code(r), 'ai_test_mode', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls at all');
  assertEq(s.a.calls[0].args.p_source, 'text', 'source'); assertEq(s.a.calls[0].args.p_audio_seconds, 0, 'no audio');
});

Deno.test('budget refusal with a new alert notifies the admin webhook without any user data', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'budget_daily', alert_created: true }), webhook: 'https://hooks.example/alert' });
  const r = await s.handler(textRequest('my secret plans for tomorrow'));
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'budget_daily', 'code');
  const hook = s.f.calls.find((c) => c.url === 'https://hooks.example/alert');
  assert(hook, 'webhook was called');
  const sent = JSON.stringify(hook!.body);
  assert(!sent.includes('user-1') && !sent.includes('secret plans'), 'webhook contains no user id or content');
  assert(sent.includes('budget_daily'), 'webhook names the alert kind');
});

Deno.test('reservation RPC failure: AI paused for safety, no paid calls', async () => {
  const s = setup({ admin: makeAdmin(null, { reserveError: true }) });
  const r = await s.handler(textRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'accounting_unavailable', 'code');
  assertEq(s.f.generateCalls().length, 0, 'no generateContent');
});

Deno.test('success (voice): reserve → transcribe → record → extract → record → finish ok', async () => {
  const s = setup();
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 200, 'status');
  const body = await r.json() as { items: { title: string }[]; usage: { captures_used: number }; session_id: string };
  assertEq(body.items.map((i) => i.title), ['Call my school'], 'validated proposals returned');
  assertEq(body.usage.captures_used, 1, 'server usage returned to the client');
  assertEq(body.session_id, 'session-1', 'session id');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_call', 'mvl_record_ai_call', 'mvl_finish_ai_capture'], 'accounting order');
  assertEq(s.a.calls[1].args, { p_reservation: 'res-1', p_audio_tokens: 960, p_text_in_tokens: 50, p_output_tokens: 20, p_thinking_tokens: 0 }, 'transcription usage recorded');
  assertEq(s.a.calls[2].args, { p_reservation: 'res-1', p_audio_tokens: 0, p_text_in_tokens: 700, p_output_tokens: 120, p_thinking_tokens: 5 }, 'extraction usage recorded');
  assertEq(s.a.calls[3].args.p_status, 'ok', 'finished ok');
  // The paid calls carry the caps that bound the reserved worst case.
  for (const g of s.f.generateCalls()) {
    const cfg = g.body.generationConfig as Json;
    assertEq(cfg.maxOutputTokens, 2048, 'output cap from reservation');
    assertEq(cfg.thinkingConfig, { thinkingBudget: 0 }, 'thinking disabled');
  }
  assertEq(s.u.inserts.length, 1, 'one voice session stored (transcript, no audio)');
  assert(!JSON.stringify(s.u.inserts[0]).includes('inline_data'), 'audio is not stored');
});

Deno.test('thinking stays enabled when the setting says so', async () => {
  const s = setup({ admin: makeAdmin({ ...RES_OK, disable_thinking: false }) });
  await s.handler(textRequest());
  const cfg = s.f.generateCalls()[0].body.generationConfig as Json;
  assert(!('thinkingConfig' in cfg), 'no thinkingConfig sent');
});

Deno.test('provider 429 during transcription: reservation closed as failed, no extraction call', async () => {
  const s = setup({ fetch: makeFetch({ generate: [429] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_busy', 'code');
  assertEq(s.f.generateCalls().length, 1, 'extraction not attempted');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_finish_ai_capture'], 'closed without recording (no usage returned)');
  assertEq(s.a.calls[1].args, { p_reservation: 'res-1', p_status: 'failed', p_error_code: 'upstream_429' }, 'failed with code');
});

Deno.test('malformed model output: usage is still recorded, then the reservation fails', async () => {
  const bad = { candidates: [{ content: { parts: [{ text: '{not json' }] } }], usageMetadata: { promptTokenCount: 1010, candidatesTokenCount: 30,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }, { modality: 'TEXT', tokenCount: 50 }] } };
  const s = setup({ fetch: makeFetch({ generate: [bad] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 502, 'status');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_call', 'mvl_finish_ai_capture'], 'recorded before failing');
  assertEq(s.a.calls[2].args.p_status, 'failed', 'failed');
});

Deno.test('accounting failure while recording: reservation is NOT closed (it expires at worst-case cost)', async () => {
  const s = setup({ admin: makeAdmin(RES_OK, { recordError: true }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 500, 'status');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_call'], 'no finish call');
  assertEq(s.f.generateCalls().length, 1, 'stopped after the first paid call');
});

Deno.test('no speech: reservation closed as failed (allowance not used), failed session logged', async () => {
  const empty = { ...TRANSCRIBE_OK, candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: '', language: 'none' }) }] } }] };
  const s = setup({ fetch: makeFetch({ generate: [empty] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 422, 'status'); assertEq(await code(r), 'no_speech', 'code');
  assertEq(s.a.calls.at(-1)!.args, { p_reservation: 'res-1', p_status: 'failed', p_error_code: 'no_speech' }, 'failed no_speech');
  assertEq(s.u.inserts[0].status, 'failed', 'failed session row');
});

Deno.test('countTokens failure: no reservation and no paid call', async () => {
  const s = setup({ fetch: makeFetch({ count: 500 }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 502, 'status');
  assertEq(s.a.calls.length, 0, 'no reservation'); assertEq(s.f.generateCalls().length, 0, 'no paid call');
});

Deno.test('audio that measures as zero seconds is refused before reserving', async () => {
  const s = setup({ fetch: makeFetch({ count: { totalTokens: 0 } }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 422, 'status');
  assertEq(s.a.calls.length, 0, 'no reservation with 0 minutes');
});

Deno.test('oversized upload and unsupported type are refused before any provider call', async () => {
  let s = setup();
  let r = await s.handler(voiceRequest(600 * 32_000 + 70_000));
  assertEq(r.status, 413, 'oversized status'); assertEq(s.f.calls.length, 0, 'no calls (oversized)');
  s = setup();
  r = await s.handler(voiceRequest(1000, 'video/mp4'));
  assertEq(r.status, 415, 'unsupported status'); assertEq(s.f.calls.length, 0, 'no calls (unsupported)');
});

Deno.test('the API key is sent only to Gemini, never to the webhook', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'budget_monthly', alert_created: true }), webhook: 'https://hooks.example/alert' });
  await s.handler(voiceRequest());
  const hook = s.f.calls.find((c) => c.url.startsWith('https://hooks.example'));
  assert(hook, 'webhook was called');
  assert(!JSON.stringify(hook).includes('test-key') && !('x-goog-api-key' in hook!.headers), 'no key in webhook URL, headers or body');
  const gemini = s.f.calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  assertEq(gemini?.headers['x-goog-api-key'], 'test-key', 'Gemini calls do carry the key (control check)');
});
