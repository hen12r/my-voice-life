// Request handler for POST /functions/v1/process-voice, with injectable dependencies so the
// orchestration (measure → reserve → paid calls → record → finish) can be tested offline.
//   multipart/form-data: audio (File), duration_ms, timezone, languages (JSON array of codes)
//   application/json:    { text, timezone, languages }   — typed input or an edited transcript
// Returns proposals only. Nothing is saved as a note/task/etc. until the client confirms.
// Audio is processed in memory and never written to storage.
//
// Two ways to pay for AI (decided per request, server-side):
//   * BYOAI (default for users): the user's OWN OpenAI key, stored in Supabase Vault, read with the
//     service-role-only RPC mvl_byoai_get_key(). Reservation: mvl_reserve_byoai_capture() (kill
//     switch, byoai_mode, plan rate limits and max length). OpenAI bills the user.
//   * Platform (staff testing only while ai_mode = admins_only): the project's OPENAI_API_KEY.
//     Reservation: mvl_reserve_ai_capture() (plan allowance, rate limits, daily/monthly budget,
//     kill switch, test mode).
// Either way a reservation is obtained BEFORE any provider call. The audio length used for that check is read from the file itself (the client's claim
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
  /** Platform provider (project key, staff testing). Undefined when OPENAI_API_KEY is not set. */
  provider: AiProvider | undefined;
  /** Builds a provider for a user's OWN key (BYOAI). The key is used only for that request. */
  userProvider?: (apiKey: string) => AiProvider;
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

  /** One open reservation: how usage is recorded and how it is closed, for either payment path. */
  interface Accounting {
    maxOutputTokens: number;
    usageInfo: Record<string, unknown>;
    transcription(seconds: number): Promise<void>;
    text(usage: unknown, worstCase: { inputTokens: number; outputTokens: number }): Promise<void>;
    finish(status: 'ok' | 'failed', code?: string): Promise<{ error: unknown }>;
  }
  type Reserved = Accounting | { refused: string };

  /** Platform key (staff testing): allowance, rate limits, budgets, kill switch. */
  async function reservePlatform(admin: SupabaseClient, userId: string, source: string, seconds: number, providerId: string, model: string): Promise<Reserved> {
    const { data: r, error } = await admin.rpc('mvl_reserve_ai_capture', {
      p_user: userId, p_source: source, p_audio_seconds: seconds, p_provider: providerId, p_model: model,
    });
    if (error || !r) {
      console.error('process-voice: reservation error', error);
      return { refused: 'accounting_unavailable' };
    }
    if (r.alert_created) notifyAdmin(String(r.reason ?? 'threshold'));
    if (!r.ok) return { refused: String(r.reason) };
    const id: string = r.reservation_id;
    return {
      maxOutputTokens: r.max_output_tokens,
      usageInfo: { plan: r.plan, captures_used: r.captures_used, captures_limit: r.captures_limit, minutes_used: r.minutes_used, minutes_limit: r.minutes_limit },
      async transcription(sec) {
        const { error } = await admin.rpc('mvl_record_ai_transcription', { p_reservation: id, p_audio_seconds: sec });
        if (error) throw new AccountingError(`record transcription failed: ${error.message}`);
      },
      async text(usage, worstCase) {
        const u = parseResponsesUsage(usage, worstCase);
        const { error } = await admin.rpc('mvl_record_ai_call', {
          p_reservation: id, p_audio_tokens: 0, p_text_in_tokens: u.text_in_tokens,
          p_output_tokens: u.output_tokens, p_thinking_tokens: u.thinking_tokens,
        });
        if (error) throw new AccountingError(`record failed: ${error.message}`);
      },
      finish: (status, code) => admin.rpc('mvl_finish_ai_capture', { p_reservation: id, p_status: status, p_error_code: code ?? null }) as unknown as Promise<{ error: unknown }>,
    };
  }

  /** User's own key (BYOAI): kill switch, byoai_mode, plan rate limits and max length. No platform budget. */
  async function reserveByoai(admin: SupabaseClient, userId: string, source: string, seconds: number): Promise<Reserved> {
    const { data: r, error } = await admin.rpc('mvl_reserve_byoai_capture', { p_user: userId, p_source: source, p_audio_seconds: seconds });
    if (error || !r) {
      console.error('process-voice: BYOAI reservation error', error);
      return { refused: 'accounting_unavailable' };
    }
    if (!r.ok) return { refused: String(r.reason) };
    const id: string = r.reservation_id;
    return {
      maxOutputTokens: r.max_output_tokens ?? 2048,
      usageInfo: { plan: r.plan, byoai: true },
      async transcription(sec) {
        const { error } = await admin.rpc('mvl_record_byoai_call', { p_reservation: id, p_audio_seconds: sec, p_input_tokens: 0, p_output_tokens: 0 });
        if (error) throw new AccountingError(`record transcription failed: ${error.message}`);
      },
      async text(usage, worstCase) {
        const u = parseResponsesUsage(usage, worstCase);
        const { error } = await admin.rpc('mvl_record_byoai_call', {
          p_reservation: id, p_audio_seconds: 0, p_input_tokens: u.text_in_tokens, p_output_tokens: u.output_tokens + u.thinking_tokens,
        });
        if (error) throw new AccountingError(`record failed: ${error.message}`);
      },
      finish: (status, code) => admin.rpc('mvl_finish_byoai_capture', { p_reservation: id, p_status: status, p_error_code: code ?? null }) as unknown as Promise<{ error: unknown }>,
    };
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'POST only');
    const supabase = deps.userClient(req);
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) return fail(req, 401, 'unauthorized', 'Sign in required');
    const userId = userData.user.id;
    const admin = deps.adminClient();

    // ---- 0. Which key pays? The user's own (BYOAI) first, else the platform key (staff testing). ----
    // Checked after authentication so anonymous callers learn nothing about configuration.
    let provider: AiProvider;
    let byoai = false;
    if (deps.userProvider) {
      const { data: userKey, error: keyError } = await admin.rpc('mvl_byoai_get_key', { p_user: userId, p_provider: 'openai' });
      if (keyError) {
        console.error(`process-voice: key lookup failed (${(keyError as { code?: string }).code ?? 'error'})`);
        return fail(req, 503, 'accounting_unavailable', 'Usage accounting is unavailable; AI is paused for safety.');
      }
      if (typeof userKey === 'string' && userKey) { provider = deps.userProvider(userKey); byoai = true; }
    }
    if (!byoai) {
      if (!deps.provider) {
        return deps.userProvider
          ? fail(req, 403, 'ai_key_required', 'Connect your own OpenAI key to use voice')
          : fail(req, 503, 'ai_not_configured', 'OPENAI_API_KEY secret is not set on this project');
      }
      provider = deps.provider;
    }

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
    const priceModel = audio ? provider!.voicePriceModel : provider!.textPriceModel;

    // ---- 2. Reserve (atomic, in the DB) ----
    const acct = byoai
      ? await reserveByoai(admin, userId, source, audio?.seconds ?? 0)
      : await reservePlatform(admin, userId, source, audio?.seconds ?? 0, provider!.id, priceModel);
    if ('refused' in acct) {
      if (acct.refused === 'accounting_unavailable') return fail(req, 503, 'accounting_unavailable', 'Usage accounting is unavailable; AI is paused for safety.');
      return fail(req, refusalStatus(acct.refused), acct.refused, 'AI request refused by usage controls');
    }
    const providerLabel = `${byoai ? 'byoai-' : ''}${provider!.id}:${audio ? priceModel : provider!.textModel}`;

    // ---- 3. Provider calls, each recorded ----
    let stage: 'transcription' | 'extraction' = 'transcription';
    try {
      let transcript = typedText;

      if (audio) {
        let t;
        try {
          t = await provider!.transcribe(audio.blob, audio.extension, languages);
        } catch (err) {
          // The provider may have processed (and billed) a request that timed out or failed on
          // its side: book the measured length so usage is never under-counted.
          if (!(err instanceof UpstreamError && err.status >= 400 && err.status < 500)) {
            await acct.transcription(audio.seconds);
          }
          throw err;
        }
        await acct.transcription(transcriptionSeconds(t.usage, audio.seconds).seconds);
        transcript = transcriptText(t.data, MAX_TEXT_CHARS);
      }

      if (!transcript) {
        await acct.finish('failed', 'no_speech');
        await supabase.from('voice_sessions').insert({ source, status: 'failed', error: 'no_speech', duration_ms: durationMs, provider: providerLabel });
        return fail(req, 422, 'no_speech', 'No speech was detected');
      }

      stage = 'extraction';
      const { data: cats } = await supabase.from('categories').select('name');
      const categories = (cats ?? []).map((c: { name: string }) => c.name);
      const { date, weekday } = localToday(timezone);
      const instructions = buildExtractionInstructions({ today: date, weekday, timezone, categories });
      const userInput = extractionInput(transcript);

      const e = await provider!.extract({ instructions, input: userInput, maxOutputTokens: acct.maxOutputTokens });
      // Worst case if usage is missing: ~1 token per 2 characters in, the full output cap out.
      await acct.text(e.usage, {
        inputTokens: Math.ceil((instructions.length + userInput.length) / 2), outputTokens: acct.maxOutputTokens,
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

      const { error: finError } = await acct.finish('ok');
      if (finError) console.error('process-voice: finish failed (reservation will expire conservatively)', finError);

      return json(req, 200, {
        session_id: session.id, transcript, language, today: date, timezone, usage: acct.usageInfo,
        duration_verified: audio ? audio.verified : null, ...result,
      });
    } catch (err) {
      console.error(`process-voice failed during ${stage}`, err);
      if (!(err instanceof AccountingError)) {
        // Close the reservation as failed: recorded usage stays, the allowance is not used.
        const code = err instanceof UpstreamError ? `upstream_${err.status}` : 'internal';
        const { error } = await acct.finish('failed', code);
        if (error) console.error('process-voice: could not close reservation', error);
      } // AccountingError: leave 'reserved' → expires (platform: at worst-case cost)
      if (err instanceof UpstreamError) {
        if (byoai) {
          // The USER's key: tell the user what to fix. Never log or return the key.
          if (err.status === 401) {
            const { error } = await admin.rpc('mvl_byoai_mark_invalid', { p_user: userId, p_provider: 'openai' });
            if (error) console.error('process-voice: could not mark the user key invalid');
            console.warn('process-voice: a user-provided OpenAI key was rejected (401); marked invalid');
            return fail(req, 400, 'ai_key_invalid', 'Your OpenAI key was rejected. Connect a new key.');
          }
          if (err.status === 403) return fail(req, 403, 'ai_key_no_model_access', `Your OpenAI project must allow ${provider!.transcribeModel} and ${provider!.textModel}.`);
          if (err.status === 429 && /insufficient_quota/.test(err.message)) return fail(req, 402, 'ai_key_no_credit', 'Your OpenAI account has no credit left.');
        } else if (err.status === 401 || err.status === 403) {
          // Wrong, revoked or project-restricted key, or a model the key's project may not use.
          // A setup problem, not an outage: say so plainly in the logs (never the key itself).
          console.error(`process-voice: OpenAI refused the request (HTTP ${err.status}). Check the OPENAI_API_KEY secret in Supabase → Edge Functions → Secrets, and that the key's project allows ${provider!.transcribeModel} and ${provider!.textModel}.`);
          return fail(req, 503, 'ai_not_configured', 'The AI provider rejected the server configuration.');
        }
        if (err.status === 404) {
          console.error(`process-voice: OpenAI returned 404. A configured model (${provider!.transcribeModel} / ${provider!.textModel}) may not exist or may not be available to this key.`);
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
