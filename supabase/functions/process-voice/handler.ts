// Request handler for POST /functions/v1/process-voice, with injectable dependencies so the
// orchestration (measure → reserve → paid calls → record → finish) can be tested offline.
//   multipart/form-data: audio (File), duration_ms, timezone, languages (JSON array of codes)
//   application/json:    { text, timezone, languages }   — typed input or an edited transcript
// Returns proposals only. Nothing is saved as a note/task/etc. until the client confirms.
// Audio is processed in memory and never written to storage.
//
// Cost control: every capture must obtain a reservation from mvl_reserve_ai_capture()
// (plan allowance, rate limits, daily/monthly budget, kill switch, test mode) BEFORE any paid
// call. The audio length used for that check is read from the file itself (the client's claim
// can only make it longer). Each call's real usage is recorded; failures close the reservation;
// if accounting itself fails, the reservation is left to expire, which books its worst-case cost.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.48.1';
import { parseAudioDuration, sniffContainer } from '../_shared/audio-duration.ts';
import { buildExtractionInstructions, extractionInput, validateExtraction } from '../_shared/extraction.ts';
import { corsHeaders, fail, json } from '../_shared/http.ts';
import { normaliseDetectedLanguage, sanitizeSpeechLanguages } from '../_shared/languages.ts';
import { audioExtension, transcriptText } from '../_shared/transcription.ts';
import { estimateCaptureSeconds, maxUploadBytes, parseResponsesUsage, refusalStatus, transcriptionSeconds } from '../_shared/usage.ts';
import { type AiProvider, UpstreamError } from './provider.ts';

export { UpstreamError } from './provider.ts';

export const ABSOLUTE_MAX_SECONDS = 600; // matches the database check on max_capture_seconds
export const MIN_AUDIO_SECONDS = 0.5;
const MAX_TEXT_CHARS = 10_000;

export interface HandlerDeps {
  /** Undefined when no provider key is configured → requests are refused with ai_not_configured. */
  provider: AiProvider | undefined;
  alertWebhookUrl?: string;
  /** Client acting as the caller (RLS applies). */
  userClient: (req: Request) => SupabaseClient;
  /** Service-role client, used ONLY for the accounting RPCs. */
  adminClient: () => SupabaseClient;
  fetch: typeof fetch;
}

class AccountingError extends Error {}
class InputError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
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

/** `languages` as a JSON array (preferred) or a comma list; legacy single `language_hint` accepted. */
function parseLanguages(raw: unknown, legacyHint: unknown): string[] {
  let list: unknown = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { list = JSON.parse(raw); } catch { list = raw.split(','); }
  } else if (typeof legacyHint === 'string' && legacyHint !== 'auto') list = [legacyHint];
  return sanitizeSpeechLanguages(list);
}

interface ValidInput {
  source: 'voice' | 'text';
  timezone: string;
  languages: string[];
  durationMs: number | null;
  audio: { blob: Blob; extension: string; seconds: number; verified: boolean } | null;
  typedText: string;
}

async function readInput(req: Request): Promise<ValidInput> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const audio = form.get('audio');
    const durationMs = Math.max(0, Math.min(3_600_000, Number(form.get('duration_ms')) || 0));
    if (!(audio instanceof File)) throw new InputError(400, 'no_audio', 'Missing audio file');
    if (audio.size === 0) throw new InputError(400, 'empty_audio', 'The recording is empty');
    if (audio.size > maxUploadBytes(ABSOLUTE_MAX_SECONDS)) throw new InputError(413, 'audio_too_long', 'Recording is too long');
    const extension = audioExtension(audio.type || 'audio/webm');
    if (!extension) throw new InputError(415, 'unsupported_audio', `Unsupported audio type ${audio.type}`);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    // Only the containers browsers record (WebM, Ogg, MP4) are accepted: for anything else the
    // server could not check the length before paying for it.
    if (!sniffContainer(bytes)) {
      throw new InputError(415, 'unsupported_audio', 'The recording format was not recognised');
    }
    const est = estimateCaptureSeconds({ parsedSeconds: parseAudioDuration(bytes), declaredMs: durationMs, bytes: bytes.length });
    if (est.seconds < MIN_AUDIO_SECONDS) throw new InputError(422, 'empty_audio', 'The recording is too short');
    return {
      source: 'voice',
      timezone: validTz(form.get('timezone')),
      languages: parseLanguages(form.get('languages'), form.get('language_hint')),
      durationMs,
      audio: { blob: new Blob([bytes], { type: audio.type }), extension, seconds: est.seconds, verified: est.verified },
      typedText: '',
    };
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.text !== 'string') throw new InputError(400, 'no_text', 'Missing text');
  const typedText = body.text.trim().slice(0, MAX_TEXT_CHARS);
  if (!typedText) throw new InputError(400, 'no_text', 'Missing text');
  return {
    source: 'text',
    timezone: validTz(body.timezone),
    languages: parseLanguages(body.languages, body.language_hint),
    durationMs: null,
    audio: null,
    typedText,
  };
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  /** Notifies the administrator of a budget alert. Contains no user data. Never blocks the response. */
  function notifyAdmin(kind: string) {
    if (!deps.alertWebhookUrl) return;
    const text = `My Voice Life: AI budget alert (${kind}). A spending threshold was reached. Check the admin dashboard.`;
    deps.fetch(deps.alertWebhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(3_000),
    }).catch((e) => console.error('alert webhook failed', e));
  }

  async function recordTranscription(admin: SupabaseClient, reservation: string, seconds: number) {
    const { error } = await admin.rpc('mvl_record_ai_transcription', { p_reservation: reservation, p_audio_seconds: seconds });
    if (error) throw new AccountingError(`record transcription failed: ${error.message}`);
  }

  async function recordTextCall(admin: SupabaseClient, reservation: string, usage: unknown, worstCase: { inputTokens: number; outputTokens: number }) {
    const u = parseResponsesUsage(usage, worstCase);
    const { error } = await admin.rpc('mvl_record_ai_call', {
      p_reservation: reservation, p_audio_tokens: 0, p_text_in_tokens: u.text_in_tokens,
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
    const provider = deps.provider;
    if (!provider) return fail(req, 503, 'ai_not_configured', 'OPENAI_API_KEY secret is not set on this project');
    const userId = userData.user.id;
    const admin = deps.adminClient();

    // ---- 1. Validate and measure the input (no paid calls yet) ----
    let input: ValidInput;
    try {
      input = await readInput(req);
    } catch (err) {
      if (err instanceof InputError) return fail(req, err.status, err.code, err.message);
      console.error('process-voice: could not read input', err);
      return fail(req, 400, 'bad_request', 'The request could not be read');
    }
    const { source, timezone, languages, durationMs, audio, typedText } = input;
    const priceModel = audio ? provider.voicePriceModel : provider.textPriceModel;

    // ---- 2. Reserve: allowance, rate limits, budgets, kill switch (atomic, in the DB) ----
    const { data: reservation, error: resError } = await admin.rpc('mvl_reserve_ai_capture', {
      p_user: userId, p_source: source, p_audio_seconds: audio?.seconds ?? 0, p_provider: provider.id, p_model: priceModel,
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
    const maxOutputTokens: number = reservation.max_output_tokens;
    const usageInfo = {
      plan: reservation.plan,
      captures_used: reservation.captures_used, captures_limit: reservation.captures_limit,
      minutes_used: reservation.minutes_used, minutes_limit: reservation.minutes_limit,
    };
    const providerLabel = `${provider.id}:${audio ? priceModel : provider.textModel}`;

    // ---- 3. Paid calls, each recorded ----
    let stage: 'transcription' | 'extraction' = 'transcription';
    try {
      let transcript = typedText;

      if (audio) {
        let t;
        try {
          t = await provider.transcribe(audio.blob, audio.extension, languages);
        } catch (err) {
          // The provider may have processed (and billed) a request that timed out or failed on
          // its side: book the measured length so spend is never under-counted.
          if (!(err instanceof UpstreamError && err.status >= 400 && err.status < 500)) {
            await recordTranscription(admin, reservationId, audio.seconds);
          }
          throw err;
        }
        await recordTranscription(admin, reservationId, transcriptionSeconds(t.usage, audio.seconds).seconds);
        transcript = transcriptText(t.data, MAX_TEXT_CHARS);
      }

      if (!transcript) {
        await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'failed', p_error_code: 'no_speech' });
        await supabase.from('voice_sessions').insert({ source, status: 'failed', error: 'no_speech', duration_ms: durationMs, provider: providerLabel });
        return fail(req, 422, 'no_speech', 'No speech was detected');
      }

      stage = 'extraction';
      const { data: cats } = await supabase.from('categories').select('name');
      const categories = (cats ?? []).map((c: { name: string }) => c.name);
      const { date, weekday } = localToday(timezone);
      const instructions = buildExtractionInstructions({ today: date, weekday, timezone, categories });
      const userInput = extractionInput(transcript);

      const e = await provider.extract({ instructions, input: userInput, maxOutputTokens });
      // Worst case if usage is missing: ~1 token per 2 characters in, the full output cap out.
      await recordTextCall(admin, reservationId, e.usage, {
        inputTokens: Math.ceil((instructions.length + userInput.length) / 2), outputTokens: maxOutputTokens,
      });
      if (e.parseError) throw e.parseError;

      const result = e.refusal
        ? { items: [], warnings: ['The assistant declined to organise this transcript. You can still save it as a note.'] }
        : validateExtraction(e.parsed, { today: date, categories });
      const detected = normaliseDetectedLanguage((e.parsed as { language?: unknown } | null)?.language);
      const language = detected === 'other' || detected === 'none' ? (languages.length === 1 ? languages[0] : detected) : detected;

      const { data: session, error: insertError } = await supabase.from('voice_sessions').insert({
        source, transcript, detected_language: language, duration_ms: durationMs, provider: providerLabel, status: 'extracted',
      }).select('id').single();
      if (insertError) throw new Error(`Could not record session: ${insertError.message}`);

      const { error: finError } = await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'ok' });
      if (finError) console.error('process-voice: finish failed (reservation will expire conservatively)', finError);

      return json(req, 200, {
        session_id: session.id, transcript, language, today: date, timezone, usage: usageInfo,
        duration_verified: audio ? audio.verified : null, ...result,
      });
    } catch (err) {
      console.error(`process-voice failed during ${stage}`, err);
      if (!(err instanceof AccountingError)) {
        // Close the reservation as failed: recorded cost stays, the monthly allowance is not used.
        const code = err instanceof UpstreamError ? `upstream_${err.status}` : 'internal';
        const { error } = await admin.rpc('mvl_finish_ai_capture', { p_reservation: reservationId, p_status: 'failed', p_error_code: code });
        if (error) console.error('process-voice: could not close reservation', error);
      } // AccountingError: leave 'reserved' → expires with worst-case cost (never under-counts spend)
      if (err instanceof UpstreamError) {
        if (err.status === 401 || err.status === 403) {
          // Wrong, revoked or project-restricted key, or a model the key's project may not use.
          // A setup problem, not an outage: say so plainly in the logs (never the key itself).
          console.error(`process-voice: OpenAI refused the request (HTTP ${err.status}). Check the OPENAI_API_KEY secret in Supabase → Edge Functions → Secrets, and that the key's project allows ${provider.transcribeModel} and ${provider.textModel}.`);
          return fail(req, 503, 'ai_not_configured', 'The AI provider rejected the server configuration.');
        }
        if (err.status === 404) {
          console.error(`process-voice: OpenAI returned 404. A configured model (${provider.transcribeModel} / ${provider.textModel}) may not exist or may not be available to this key.`);
        }
        if (err.status === 429) return fail(req, 503, 'ai_busy', 'The AI provider is rate limiting requests. Try again shortly.');
        if (err.status === 400 || err.status === 413 || err.status === 415) return fail(req, 422, 'ai_rejected_input', 'The AI provider could not process this recording.');
        return fail(req, 502, 'ai_unavailable', 'The AI provider is unavailable.');
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') return fail(req, 504, 'ai_timeout', 'The AI provider timed out.');
      return fail(req, 500, 'internal', 'Unexpected error');
    }
  };
}
