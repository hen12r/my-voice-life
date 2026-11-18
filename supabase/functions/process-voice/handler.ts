// Request handler for POST /functions/v1/process-voice, with injectable dependencies so the
// orchestration (reserve → paid calls → record → finish) can be tested without network access.
//   multipart/form-data: audio (File), duration_ms, timezone, language_hint (auto|en|fr|rw)
//   application/json:    { text, timezone, language_hint }   — typed input or an edited transcript
// Returns proposals only. Nothing is saved as a note/task/etc. until the client confirms.
// Audio is processed in memory and never written to storage.
//
// Cost control: every capture must obtain a reservation from mvl_reserve_ai_capture()
// (plan allowance, rate limits, daily/monthly budget, kill switch, test mode) BEFORE any
// paid Gemini call. Each call's real token usage is recorded; failures close the
// reservation; if accounting itself fails, the reservation is left to expire, which
// books its worst-case cost (never under-counts spend).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.48.1';
import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA, validateExtraction } from '../_shared/extraction.ts';
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { buildTranscriptionPrompt, LANGUAGE_NAMES, TRANSCRIPT_SCHEMA } from '../_shared/transcription.ts';
import { audioSecondsFromCount, maxUploadBytes, parseUsageMetadata, refusalStatus } from '../_shared/usage.ts';

export const ABSOLUTE_MAX_SECONDS = 600; // matches the database check on max_capture_seconds
const MAX_TEXT_CHARS = 10_000;
const ALLOWED_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac'];

export interface HandlerDeps {
  geminiApiKey: string | undefined;
  geminiModel: string;
  alertWebhookUrl?: string;
  /** Client acting as the caller (RLS applies). */
  userClient: (req: Request) => SupabaseClient;
  /** Service-role client, used ONLY for the accounting RPCs. */
  adminClient: () => SupabaseClient;
  fetch: typeof fetch;
}

export class UpstreamError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
class AccountingError extends Error {}

interface CallLimits { maxOutputTokens: number; disableThinking: boolean }

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function localToday(tz: string) {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  return { date, weekday };
}

function validTz(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const API = `https://generativelanguage.googleapis.com/v1beta/models/${deps.geminiModel}`;

  async function geminiFetch(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await deps.fetch(`${API}:${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': deps.geminiApiKey! },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new UpstreamError(res.status, `Gemini ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }

  /** Free endpoint: exact audio length before any paid call. */
  async function measureAudioSeconds(part: unknown): Promise<number> {
    const count = await geminiFetch('countTokens', { contents: [{ role: 'user', parts: [part] }] });
    return audioSecondsFromCount(count);
  }

  async function generate(parts: unknown[], schema: unknown, limits: CallLimits) {
    const data = await geminiFetch('generateContent', {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: limits.maxOutputTokens,          // bounds the worst-case cost reserved in the DB
        ...(limits.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    });
    // deno-lint-ignore no-explicit-any
    const cand = (data.candidates as any[])?.[0];
    const text = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
    let parsed: unknown = null;
    let parseError: UpstreamError | null = null;
    if (!text) parseError = new UpstreamError(502, `Gemini returned no content (finishReason: ${cand?.finishReason ?? 'unknown'})`);
    else {
      try { parsed = JSON.parse(text); } catch { parseError = new UpstreamError(502, 'Gemini returned malformed JSON'); }
    }
    return { parsed, parseError, usage: data.usageMetadata };
  }

  /** Notifies the administrator of a budget alert. Contains no user data. Never blocks the response. */
  function notifyAdmin(kind: string) {
    if (!deps.alertWebhookUrl) return;
    const text = `My Voice Life: AI budget alert (${kind}). A spending threshold was reached. Check the admin dashboard.`;
    deps.fetch(deps.alertWebhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(3_000),
    }).catch((e) => console.error('alert webhook failed', e));
  }

  async function record(admin: SupabaseClient, reservation: string, usage: unknown, hadAudio: boolean) {
    const u = parseUsageMetadata(usage, hadAudio);
    const { error } = await admin.rpc('mvl_record_ai_call', {
      p_reservation: reservation, p_audio_tokens: u.audio_tokens, p_text_in_tokens: u.text_in_tokens,
      p_output_tokens: u.output_tokens, p_thinking_tokens: u.thinking_tokens,
    });
    if (error) throw new AccountingError(`record failed: ${error.message}`);
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const supabase = deps.userClient(req);
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) return fail(req, 401, 'unauthorized', 'Sign in required');
    // Checked after authentication so anonymous callers learn nothing about configuration.
    if (!deps.geminiApiKey) return fail(req, 503, 'ai_not_configured', 'GEMINI_API_KEY secret is not set on this project');
    const userId = userData.user.id;
    const admin = deps.adminClient();

    let source: 'voice' | 'text';
    let timezone = 'UTC';
    let hint = 'auto';
    let durationMs: number | null = null;
    let audioPart: { inline_data: { mime_type: string; data: string } } | null = null;
    let typedText = '';
    let audioSeconds = 0;

    // ---- 1. Validate input cheaply (no paid calls yet) ----
    try {
      const contentType = req.headers.get('content-type') ?? '';
      if (contentType.startsWith('multipart/form-data')) {
        source = 'voice';
        const form = await req.formData();
        const audio = form.get('audio');
        timezone = validTz(form.get('timezone'));
        hint = String(form.get('language_hint') ?? 'auto');
        durationMs = Math.max(0, Math.min(3_600_000, Number(form.get('duration_ms')) || 0));
        if (!(audio instanceof File)) return fail(req, 400, 'no_audio', 'Missing audio file');
        if (audio.size === 0) return fail(req, 400, 'empty_audio', 'The recording is empty');
        if (audio.size > maxUploadBytes(ABSOLUTE_MAX_SECONDS)) return fail(req, 413, 'audio_too_long', 'Recording is too long');
        const mime = (audio.type || 'audio/webm').split(';')[0];
        if (!ALLOWED_AUDIO.includes(mime)) return fail(req, 415, 'unsupported_audio', `Unsupported audio type ${mime}`);
        audioPart = { inline_data: { mime_type: mime, data: toBase64(new Uint8Array(await audio.arrayBuffer())) } };
        audioSeconds = await measureAudioSeconds(audioPart); // free call: exact length for the allowance check
        // A recording with no measurable audio cannot be accounted for: refuse rather than reserve 0 minutes.
        if (!(audioSeconds > 0)) return fail(req, 422, 'no_speech', 'No audio could be measured in the recording');
      } else {
        source = 'text';
        const body = await req.json().catch(() => null);
        if (!body || typeof body.text !== 'string') return fail(req, 400, 'no_text', 'Missing text');
        typedText = body.text.trim().slice(0, MAX_TEXT_CHARS);
        if (!typedText) return fail(req, 400, 'no_text', 'Missing text');
        timezone = validTz(body.timezone);
        hint = typeof body.language_hint === 'string' ? body.language_hint : 'auto';
      }
    } catch (err) {
      console.error('process-voice: input/measure failed', err);
      return fail(req, 502, 'ai_unavailable', 'Could not measure the recording.');
    }

    // ---- 2. Reserve: allowance, rate limits, budgets, kill switch (atomic, in the DB) ----
    const { data: reservation, error: resError } = await admin.rpc('mvl_reserve_ai_capture', {
      p_user: userId, p_source: source, p_audio_seconds: audioSeconds, p_provider: 'gemini', p_model: deps.geminiModel,
    });
    if (resError || !reservation) {
      console.error('process-voice: reservation error', resError);
      return fail(req, 503, 'accounting_unavailable', 'Usage accounting is unavailable; AI is paused for safety.');
    }
    if (reservation.alert_created) notifyAdmin(String(reservation.reason ?? 'threshold'));
    if (!reservation.ok) {
      const reason = String(reservation.reason);
      return fail(req, refusalStatus(reason), reason, 'AI request refused by usage controls');
    }

    const reservationId: string = reservation.reservation_id;
    const limits: CallLimits = { maxOutputTokens: reservation.max_output_tokens, disableThinking: reservation.disable_thinking };
    const usageInfo = {
      plan: reservation.plan,
      captures_used: reservation.captures_used, captures_limit: reservation.captures_limit,
      minutes_used: reservation.minutes_used, minutes_limit: reservation.minutes_limit,
    };

    // ---- 3. Paid calls, each recorded ----
    try {
      let transcript = typedText;
      let language = LANGUAGE_NAMES[hint] ? hint : 'other';

      if (audioPart) {
        const t = await generate([audioPart, { text: buildTranscriptionPrompt(hint) }], TRANSCRIPT_SCHEMA, limits);
        await record(admin, reservationId, t.usage, true);
        if (t.parseError) throw t.parseError;
        const out = (t.parsed ?? {}) as { transcript?: unknown; language?: unknown };
        transcript = typeof out.transcript === 'string' ? out.transcript.trim().slice(0, MAX_TEXT_CHARS) : '';
        language = typeof out.language === 'string' ? out.language : 'other';
      }

      if (!transcript) {
        await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'failed', p_error_code: 'no_speech' });
        await supabase.from('voice_sessions').insert({ source, status: 'failed', error: 'no_speech', duration_ms: durationMs, provider: deps.geminiModel });
        return fail(req, 422, 'no_speech', 'No speech was detected');
      }

      const { data: cats } = await supabase.from('categories').select('name');
      const categories = (cats ?? []).map((c: { name: string }) => c.name);
      const { date, weekday } = localToday(timezone);

      const e = await generate([{ text: buildExtractionPrompt({ transcript, today: date, weekday, timezone, categories }) }], EXTRACTION_RESPONSE_SCHEMA, limits);
      await record(admin, reservationId, e.usage, false);
      if (e.parseError) throw e.parseError;
      const result = validateExtraction(e.parsed, { today: date, categories });

      const { data: session, error: insertError } = await supabase.from('voice_sessions').insert({
        source, transcript, detected_language: language, duration_ms: durationMs, provider: deps.geminiModel, status: 'extracted',
      }).select('id').single();
      if (insertError) throw new Error(`Could not record session: ${insertError.message}`);

      const { error: finError } = await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'ok' });
      if (finError) console.error('process-voice: finish failed (reservation will expire conservatively)', finError);

      return json(req, 200, { session_id: session.id, transcript, language, today: date, timezone, usage: usageInfo, ...result });
    } catch (err) {
      console.error('process-voice failed', err);
      if (!(err instanceof AccountingError)) {
        // Close the reservation as failed: recorded cost stays, the monthly allowance is not used.
        const code = err instanceof UpstreamError ? `upstream_${err.status}` : 'internal';
        const { error } = await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'failed', p_error_code: code });
        if (error) console.error('process-voice: could not close reservation', error);
      } // AccountingError: leave 'reserved' → expires with worst-case cost (never under-counts spend)
      if (err instanceof UpstreamError) {
        if (err.status === 429) return fail(req, 503, 'ai_busy', 'The AI provider is rate limiting requests. Try again shortly.');
        if (err.status === 400) return fail(req, 422, 'ai_rejected_input', 'The AI provider could not process this recording.');
        return fail(req, 502, 'ai_unavailable', 'The AI provider is unavailable.');
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') return fail(req, 504, 'ai_timeout', 'The AI provider timed out.');
      return fail(req, 500, 'internal', 'Unexpected error');
    }
  };
}
