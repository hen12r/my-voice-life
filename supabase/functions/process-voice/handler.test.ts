// Orchestration tests for process-voice (run with: npm run test:functions).
// OpenAI and Supabase are replaced by in-memory fakes that record every call; the REAL OpenAI
// provider (request building and response parsing) and REAL recordings are used, so these tests
// prove the cost-control order of operations and the exact requests sent — without network
// access or a key.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.48.1';
import { createHandler, type HandlerDeps } from './handler.ts';
import { createOpenAiProvider } from './provider.ts';

// ---------- tiny assertion helpers (no external test libraries) ----------
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

const FIX = 'supabase/functions/_shared/__fixtures__';
const CHROME_4S = await Deno.readFile(`${FIX}/chrome-4s.webm`);      // real Chromium MediaRecorder output (3.96 s)
const LOWRATE_60S = await Deno.readFile(`${FIX}/lowrate-60s.webm`);  // 60 s at 6 kbit/s (52 KB)
const FRAG_MP4 = await Deno.readFile(`${FIX}/frag-7s.mp4`);          // fragmented MP4/AAC (7.32 s)

// ---------- fakes ----------
type Json = Record<string, unknown>;
interface FetchCall { url: string; json: Json | null; form: FormData | null; headers: Record<string, string> }

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const TRANSCRIBE_OK = { text: 'Tomorrow I need to call my school, prepare my CV and practise piano.', usage: { type: 'duration', seconds: 4.1 } };
const responsesOk = (payload: Json, usage: Json = { input_tokens: 900, output_tokens: 150, output_tokens_details: { reasoning_tokens: 0 } }) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
  usage,
});
const item = (title: string, extra: Json = {}) => ({
  type: 'task', title, body: null, category: null, priority: 'normal', date: tomorrow, time: null,
  date_text: 'tomorrow', date_confidence: 'explicit', ...extra,
});
const EXTRACT_OK = responsesOk({ language: 'en', items: [item('Call my school', { category: 'School' }), item('Prepare my CV'), item('Practise piano')] });
const RES_OK = {
  ok: true, reservation_id: 'res-1', plan: 'free', alert_created: false, max_output_tokens: 2048, disable_thinking: true,
  captures_used: 1, captures_limit: 7, minutes_used: 0.1, minutes_limit: 15,
};

function makeFetch(opts: { transcribe?: (Json | number)[]; responses?: (Json | number)[]; throwOn?: 'transcribe' } = {}) {
  const calls: FetchCall[] = [];
  const tq = [...(opts.transcribe ?? [TRANSCRIBE_OK])];
  const rq = [...(opts.responses ?? [EXTRACT_OK])];
  // A number = an error status with a plain body; { __status, body } = an error status with a
  // JSON body (used to imitate the SHAPE of OpenAI error bodies; these are fakes, not real replies).
  const respond = (v: Json | number) =>
    typeof v === 'number' ? new Response('provider error', { status: v })
    : typeof v.__status === 'number' ? new Response(JSON.stringify(v.body), { status: v.__status })
    : new Response(JSON.stringify(v), { status: 200 });
  const fn: typeof fetch = (input, init) => {
    const url = String(input);
    const form = init?.body instanceof FormData ? init.body : null;
    const json = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, json, form, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url.endsWith('/audio/transcriptions')) {
      if (opts.throwOn === 'transcribe') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
      return Promise.resolve(respond(tq.shift() ?? 500));
    }
    if (url.endsWith('/responses')) return Promise.resolve(respond(rq.shift() ?? 500));
    return Promise.resolve(new Response('ok')); // webhook
  };
  const of = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix));
  return { fn, calls, transcriptions: () => of('/audio/transcriptions'), responses: () => of('/responses') };
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
      if (name.startsWith('mvl_record_')) return Promise.resolve(opts.recordError ? { data: null, error: { message: 'record failed' } } : { data: 0.001, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client: client as unknown as SupabaseClient, calls, names: () => calls.map((c) => c.name) };
}

function setup(p: { fetch?: ReturnType<typeof makeFetch>; user?: ReturnType<typeof makeUser>; admin?: ReturnType<typeof makeAdmin>; noKey?: boolean; webhook?: string } = {}) {
  const f = p.fetch ?? makeFetch();
  const u = p.user ?? makeUser();
  const a = p.admin ?? makeAdmin();
  const deps: HandlerDeps = {
    provider: p.noKey ? undefined : createOpenAiProvider({ apiKey: 'test-key', transcribeModel: 'gpt-transcribe', textModel: 'gpt-6-luna', fetch: f.fn }),
    alertWebhookUrl: p.webhook,
    userClient: () => u.client, adminClient: () => a.client, fetch: f.fn,
  };
  return { handler: createHandler(deps), f, u, a };
}

function voiceRequest(opts: { bytes?: Uint8Array; type?: string; durationMs?: number; languages?: string } = {}) {
  const form = new FormData();
  form.append('audio', new File([opts.bytes ?? CHROME_4S], 'capture.webm', { type: opts.type ?? 'audio/webm;codecs=opus' }));
  form.append('timezone', 'Africa/Kigali');
  form.append('languages', opts.languages ?? '["en","fr"]');
  form.append('duration_ms', String(opts.durationMs ?? 4000));
  return new Request('http://localhost/process-voice', { method: 'POST', body: form, headers: { Authorization: 'Bearer t', Origin: 'http://localhost:3000' } });
}
function textRequest(text = 'Tomorrow I need to call my school') {
  return new Request('http://localhost/process-voice', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ text, timezone: 'Africa/Kigali', languages: ['en'] }),
  });
}
const code = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;

// ---------- access and configuration ----------
Deno.test('no API key: signed-in user gets ai_not_configured, no provider or accounting calls', async () => {
  const s = setup({ noKey: true });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_not_configured', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls'); assertEq(s.a.calls.length, 0, 'no accounting calls');
});

Deno.test('unauthenticated without a key configured: still 401 (configuration not revealed)', async () => {
  const s = setup({ user: makeUser(false), noKey: true });
  assertEq((await s.handler(textRequest())).status, 401, 'status');
});

Deno.test('unauthenticated: 401, no provider or accounting calls', async () => {
  const s = setup({ user: makeUser(false) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 401, 'status');
  assertEq(s.f.calls.length, 0, 'no provider calls'); assertEq(s.a.calls.length, 0, 'no accounting calls');
});

Deno.test('non-staff user in admins_only mode: refused with ai_test_mode, zero provider calls', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'ai_test_mode', alert_created: false }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 403, 'status'); assertEq(await code(r), 'ai_test_mode', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls at all');
});

// ---------- measuring before paying ----------
Deno.test('allowance refusal: the duration read from the real file is reserved, no paid call', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'quota_captures', alert_created: false }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 429, 'status'); assertEq(await code(r), 'quota_captures', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture'], 'no record/finish after refusal');
  assertEq(s.a.calls[0].args, { p_user: 'user-1', p_source: 'voice', p_audio_seconds: 4, p_provider: 'openai', p_model: 'gpt-transcribe+gpt-6-luna' }, 'reservation args');
});

Deno.test('a client claiming a 60 s low-bitrate file is 2 s cannot hide its length', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'audio_too_long', alert_created: false }) });
  const r = await s.handler(voiceRequest({ bytes: LOWRATE_60S, durationMs: 2000 }));
  assertEq(r.status, 413, 'status');
  assert((s.a.calls[0].args.p_audio_seconds as number) >= 60, `reserved ${s.a.calls[0].args.p_audio_seconds}s, expected >= 60`);
  assertEq(s.f.calls.length, 0, 'no provider calls');
});

Deno.test('the client can only make the reserved length longer, never shorter', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'quota_minutes', alert_created: false }) });
  await s.handler(voiceRequest({ durationMs: 30_000 }));
  assertEq(s.a.calls[0].args.p_audio_seconds, 30, 'declared 30 s > parsed 3.96 s → 30 s held');
});

Deno.test('fragmented MP4 (Safari-style) is measured from its fragments', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'quota_minutes', alert_created: false }) });
  await s.handler(voiceRequest({ bytes: FRAG_MP4, type: 'audio/mp4', durationMs: 0 }));
  assertEq(s.a.calls[0].args.p_audio_seconds, 7.33, 'MP4 duration (rounded up)');
});

Deno.test('empty, too short, oversized, unknown or unsupported audio: refused before reserving', async () => {
  const cases: [Uint8Array, string, number, string][] = [
    [new Uint8Array(0), 'audio/webm', 400, 'empty_audio'],
    [new TextEncoder().encode('not audio at all'), 'audio/webm', 415, 'unsupported_audio'],
    [new Uint8Array(600 * 32_000 + 70_000), 'audio/webm', 413, 'audio_too_long'],
    [CHROME_4S, 'image/png', 415, 'unsupported_audio'],
  ];
  for (const [bytes, type, status, c] of cases) {
    const s = setup();
    const r = await s.handler(voiceRequest({ bytes, type, durationMs: 1000 }));
    assertEq(r.status, status, `${c} status`); assertEq(await code(r), c, `${c} code`);
    assertEq(s.a.calls.length, 0, `${c}: no reservation`); assertEq(s.f.calls.length, 0, `${c}: no provider call`);
  }
  const s = setup();
  const r = await s.handler(voiceRequest({ bytes: CHROME_4S.slice(0, 300), durationMs: 200 }));
  assertEq(await code(r), 'empty_audio', 'a fraction of a second is refused as empty');
  assertEq(s.a.calls.length, 0, 'no reservation for a too-short recording');
});

// ---------- the successful path ----------
Deno.test('success (voice): reserve → transcribe → record seconds → extract → record tokens → finish ok', async () => {
  const s = setup();
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 200, 'status');
  const body = await r.json() as { items: { title: string; type: string; date: string | null }[]; transcript: string; language: string; duration_verified: boolean };
  assertEq(body.items.map((i) => i.title), ['Call my school', 'Prepare my CV', 'Practise piano'], 'three separate actions');
  assert(body.items.every((i) => i.type === 'task' && i.date === tomorrow), 'categorised as tasks dated tomorrow');
  assertEq(body.language, 'en', 'detected language'); assertEq(body.duration_verified, true, 'duration read from the file');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_transcription', 'mvl_record_ai_call', 'mvl_finish_ai_capture'], 'accounting order');
  assertEq(s.a.calls[1].args, { p_reservation: 'res-1', p_audio_seconds: 4.1 }, 'billed duration reported by the provider is recorded');
  assertEq(s.a.calls[2].args, { p_reservation: 'res-1', p_audio_tokens: 0, p_text_in_tokens: 900, p_output_tokens: 150, p_thinking_tokens: 0 }, 'extraction tokens recorded');
  assertEq(s.a.calls[3].args.p_status, 'ok', 'finished ok');
  assertEq(s.u.inserts.length, 1, 'one voice session stored');
  assertEq(s.u.inserts[0].provider, 'openai:gpt-transcribe+gpt-6-luna', 'provider label');
  assert(!('audio' in s.u.inserts[0]) && !JSON.stringify(s.u.inserts[0]).includes('webm'), 'audio is not stored');
});

Deno.test('transcription request: model, file, json format and language hints (multipart)', async () => {
  const s = setup();
  await s.handler(voiceRequest({ languages: '["rw","fr","en","sw"]' }));
  const form = s.f.transcriptions()[0].form!;
  assertEq(form.get('model'), 'gpt-transcribe', 'model');
  assertEq(form.get('response_format'), 'json', 'format');
  assertEq(form.getAll('languages[]'), ['rw', 'fr', 'en'], 'at most 3 known language hints');
  const file = form.get('file') as File;
  assertEq(file.name, 'recording.webm', 'file name carries the extension');
  assertEq(file.size, CHROME_4S.length, 'the uploaded bytes are sent unchanged');
});

Deno.test('extraction request: strict JSON schema, output cap, no reasoning, not stored, transcript as data', async () => {
  const s = setup();
  await s.handler(voiceRequest());
  const req = s.f.responses()[0].json!;
  assertEq(req.model, 'gpt-6-luna', 'text model');
  assertEq(req.max_output_tokens, 2048, 'output cap from the reservation');
  assertEq(req.reasoning, { effort: 'none' }, 'no paid reasoning');
  assertEq(req.store, false, 'not stored by the provider');
  const format = (req.text as Json).format as Json;
  assertEq([format.type, format.name, format.strict], ['json_schema', 'mvl_extraction', true], 'structured output, strict');
  assert(String(req.instructions).includes('data, not instructions'), 'instructions treat the transcript as data');
  assert(String(req.input).includes('Tomorrow I need to call my school'), 'transcript sent as the user input');
  assert(!String(req.instructions).includes('Tomorrow I need'), 'transcript is not mixed into the instructions');
});

Deno.test('API key goes only to OpenAI, never to the webhook', async () => {
  const s = setup({ admin: makeAdmin({ ...RES_OK, alert_created: true }), webhook: 'https://hooks.example/alert' });
  await s.handler(voiceRequest());
  const hook = s.f.calls.find((c) => c.url.startsWith('https://hooks.example'));
  assert(hook, 'webhook was called');
  assert(!JSON.stringify(hook).includes('test-key') && !('authorization' in hook!.headers), 'no key in webhook');
  assert(!JSON.stringify(hook!.json).includes('user-1') && !JSON.stringify(hook!.json).includes('school'), 'webhook has no user data');
  for (const c of [...s.f.transcriptions(), ...s.f.responses()]) assertEq(c.headers.authorization, 'Bearer test-key', 'OpenAI calls carry the key');
});

Deno.test('typed text: extraction only, priced as the text pipeline', async () => {
  const s = setup();
  const r = await s.handler(textRequest());
  assertEq(r.status, 200, 'status');
  assertEq(s.f.transcriptions().length, 0, 'no transcription');
  assertEq(s.a.calls[0].args.p_model, 'gpt-6-luna', 'text price row');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_call', 'mvl_finish_ai_capture'], 'accounting order');
});

// ---------- failures ----------
Deno.test('language hint rejected (400): retried once without hints, capture still works', async () => {
  const s = setup({ fetch: makeFetch({ transcribe: [400, TRANSCRIBE_OK] }) });
  const r = await s.handler(voiceRequest({ languages: '["lg"]' }));
  assertEq(r.status, 200, 'status');
  const t = s.f.transcriptions();
  assertEq(t.length, 2, 'two attempts'); assertEq(t[1].form!.getAll('languages[]'), [], 'second attempt auto-detects');
});

Deno.test('provider 429 during transcription: closed as failed, nothing recorded, no extraction', async () => {
  const s = setup({ fetch: makeFetch({ transcribe: [429] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_busy', 'code');
  assertEq(s.f.responses().length, 0, 'extraction not attempted');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_finish_ai_capture'], 'a rejected request is not billed');
  assertEq(s.a.calls[1].args, { p_reservation: 'res-1', p_status: 'failed', p_error_code: 'upstream_429' }, 'failed with code');
});

/** Runs fn while capturing console output, so tests can prove what is (not) logged. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...a: unknown[]) => { lines.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.error = grab; console.warn = grab; console.log = grab;
  try { return { result: await fn(), logs: lines.join('\n') }; } finally { Object.assign(console, orig); }
}

// Fake 401 body in the shape OpenAI uses for a wrong key (it echoes a masked key fragment).
const FAKE_401 = { __status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-************************ab12. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', code: 'invalid_api_key' } } };

Deno.test('wrong or revoked key (401) on transcription: ai_not_configured, not billed, no key fragment in logs', async () => {
  const s = setup({ fetch: makeFetch({ transcribe: [FAKE_401] }) });
  const { result: r, logs } = await captureLogs(() => s.handler(voiceRequest()));
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_not_configured', 'code');
  assertEq(s.f.responses().length, 0, 'extraction not attempted');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_finish_ai_capture'], 'a refused request is not billed');
  assertEq(s.a.calls[1].args.p_error_code, 'upstream_401', 'failure code');
  assert(logs.includes('OPENAI_API_KEY'), 'logs point the admin at the secret');
  assert(!logs.includes('ab12'), 'masked key fragment from the error body is redacted');
  assert(!logs.includes('test-key'), 'the configured key never appears in logs');
});

Deno.test('key not allowed to use the text model (403) on extraction: ai_not_configured, transcription still booked', async () => {
  const s = setup({ fetch: makeFetch({ responses: [{ __status: 403, body: { error: { message: 'Project does not have access to model gpt-6-luna', code: 'model_not_allowed' } } }] }) });
  const { result: r, logs } = await captureLogs(() => s.handler(voiceRequest()));
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'ai_not_configured', 'code');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_transcription', 'mvl_finish_ai_capture'], 'the transcription that ran is booked; extraction was refused');
  assert(logs.includes('gpt-6-luna'), 'logs name the models to allow');
  const body = JSON.stringify(await setup({ fetch: makeFetch({ responses: [403] }) }).handler(voiceRequest()).then((x) => x.json()));
  assert(!body.includes('test-key') && !body.includes('OPENAI_API_KEY'), 'the browser gets a generic message, no configuration details');
});

Deno.test('the key is never sent anywhere except api.openai.com, and never returned to the browser', async () => {
  const s = setup();
  const r = await s.handler(voiceRequest());
  const text = await r.text();
  assert(!text.includes('test-key'), 'response body has no key');
  for (const c of s.f.calls) {
    if (c.headers.authorization?.includes('test-key')) assert(c.url.startsWith('https://api.openai.com/'), `key only sent to OpenAI, not ${c.url}`);
  }
});

Deno.test('provider timeout during transcription: measured length is booked (may have been billed)', async () => {
  const s = setup({ fetch: makeFetch({ throwOn: 'transcribe' }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 504, 'status');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_transcription', 'mvl_finish_ai_capture'], 'conservative record, then failed');
  assertEq(s.a.calls[1].args.p_audio_seconds, 4, 'server-measured seconds booked');
});

Deno.test('provider reports tokens instead of duration: the server-measured length is billed', async () => {
  const s = setup({ fetch: makeFetch({ transcribe: [{ text: 'Buy bread', usage: { type: 'tokens', input_tokens: 60, output_tokens: 5 } }] }) });
  await s.handler(voiceRequest());
  assertEq(s.a.calls[1].args, { p_reservation: 'res-1', p_audio_seconds: 4 }, 'measured seconds used');
});

Deno.test('invalid structured output: usage recorded, then the reservation fails', async () => {
  const bad = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{not json' }] }], usage: { input_tokens: 800, output_tokens: 20 } };
  const s = setup({ fetch: makeFetch({ responses: [bad] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 502, 'status');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_transcription', 'mvl_record_ai_call', 'mvl_finish_ai_capture'], 'recorded before failing');
  assertEq(s.a.calls.at(-1)!.args.p_status, 'failed', 'failed');
});

Deno.test('incomplete response (output cap hit): treated as a failure, usage recorded', async () => {
  const incomplete = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 800, output_tokens: 2048 } };
  const s = setup({ fetch: makeFetch({ responses: [incomplete] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 502, 'status');
  assertEq(s.a.calls[2].args.p_output_tokens, 2048, 'full output cap recorded');
});

Deno.test('schema-valid but untrustworthy items are still cleaned by validateExtraction', async () => {
  const sneaky = responsesOk({ language: 'fr', items: [
    item('Rendez-vous', { type: 'event', date: tomorrow, date_confidence: 'ambiguous', date_text: 'bientôt' }),
    item('Unknown kind', { type: 'banana' }),
  ] });
  const s = setup({ fetch: makeFetch({ responses: [sneaky] }) });
  const body = await (await s.handler(voiceRequest())).json() as { items: { date: string | null; needs_date: boolean }[]; language: string };
  assertEq(body.items.length, 1, 'unknown type dropped');
  assertEq([body.items[0].date, body.items[0].needs_date], [null, true], 'ambiguous date cleared, event needs a date');
  assertEq(body.language, 'fr', 'language from the model');
});

Deno.test('model refusal: no items, a warning, the transcript is still returned', async () => {
  const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }], usage: { input_tokens: 700, output_tokens: 10 } };
  const s = setup({ fetch: makeFetch({ responses: [refusal] }) });
  const r = await s.handler(voiceRequest());
  const body = await r.json() as { items: unknown[]; warnings: string[]; transcript: string };
  assertEq(r.status, 200, 'status'); assertEq(body.items.length, 0, 'no items');
  assert(body.warnings[0].includes('declined'), 'warning'); assert(body.transcript.length > 0, 'transcript kept');
});

Deno.test('missing usage on extraction: worst case recorded (never under-counted)', async () => {
  const noUsage = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ language: 'en', items: [] }) }] }] };
  const s = setup({ fetch: makeFetch({ responses: [noUsage] }) });
  await s.handler(voiceRequest());
  assertEq(s.a.calls[2].args.p_output_tokens, 2048, 'output cap booked');
  assert((s.a.calls[2].args.p_text_in_tokens as number) > 500, 'input estimate booked');
});

Deno.test('accounting failure while recording: reservation is NOT closed (it expires at worst-case cost)', async () => {
  const s = setup({ admin: makeAdmin(RES_OK, { recordError: true }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 500, 'status');
  assertEq(s.a.names(), ['mvl_reserve_ai_capture', 'mvl_record_ai_transcription'], 'no finish call');
  assertEq(s.f.responses().length, 0, 'stopped after the first paid call');
});

Deno.test('no speech: closed as failed (allowance not used), failed session logged', async () => {
  const s = setup({ fetch: makeFetch({ transcribe: [{ text: '   ', usage: { type: 'duration', seconds: 4 } }] }) });
  const r = await s.handler(voiceRequest());
  assertEq(r.status, 422, 'status'); assertEq(await code(r), 'no_speech', 'code');
  assertEq(s.a.calls.at(-1)!.args, { p_reservation: 'res-1', p_status: 'failed', p_error_code: 'no_speech' }, 'failed no_speech');
  assertEq(s.u.inserts[0].status, 'failed', 'failed session row');
  assertEq(s.f.responses().length, 0, 'no extraction for silence');
});

Deno.test('reservation RPC failure: AI paused for safety, no paid calls', async () => {
  const s = setup({ admin: makeAdmin(null, { reserveError: true }) });
  const r = await s.handler(textRequest());
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'accounting_unavailable', 'code');
  assertEq(s.f.calls.length, 0, 'no provider calls');
});

Deno.test('budget refusal with a new alert notifies the admin webhook without any user data', async () => {
  const s = setup({ admin: makeAdmin({ ok: false, reason: 'budget_daily', alert_created: true }), webhook: 'https://hooks.example/alert' });
  const r = await s.handler(textRequest('my secret plans for tomorrow'));
  assertEq(r.status, 503, 'status'); assertEq(await code(r), 'budget_daily', 'code');
  const hook = s.f.calls.find((c) => c.url === 'https://hooks.example/alert');
  assert(hook, 'webhook was called');
  const sent = JSON.stringify(hook!.json);
  assert(!sent.includes('user-1') && !sent.includes('secret plans'), 'webhook contains no user id or content');
  assert(sent.includes('budget_daily'), 'webhook names the alert kind');
});
