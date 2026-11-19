// Pure helpers for AI usage accounting (no Deno/browser APIs) — shared and unit-tested.

/** Gemini counts audio input at 32 tokens per second (ai.google.dev/gemini-api/docs/audio). */
export const AUDIO_TOKENS_PER_SECOND = 32;

export interface CallUsage {
  audio_tokens: number;
  text_in_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * Converts Gemini's `usageMetadata` into the ledger's token buckets.
 * If the per-modality breakdown is missing on a call that contained audio, all prompt
 * tokens are booked as audio (the more expensive rate), so costs are never under-estimated.
 */
export function parseUsageMetadata(meta: unknown, callHadAudio: boolean): CallUsage {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const prompt = int(m.promptTokenCount);
  const details = Array.isArray(m.promptTokensDetails) ? (m.promptTokensDetails as Record<string, unknown>[]) : null;
  let audio = 0;
  let text = 0;
  if (details && details.length) {
    for (const d of details) {
      const n = int(d.tokenCount);
      if (String(d.modality).toUpperCase() === 'AUDIO') audio += n; else text += n;
    }
    // Any prompt tokens not covered by the breakdown are booked conservatively.
    const rest = Math.max(0, prompt - audio - text);
    if (callHadAudio) audio += rest; else text += rest;
  } else if (callHadAudio) {
    audio = prompt;
  } else {
    text = prompt;
  }
  return { audio_tokens: audio, text_in_tokens: text, output_tokens: int(m.candidatesTokenCount), thinking_tokens: int(m.thoughtsTokenCount) };
}

/** Audio length from a countTokens response for an audio-only request. */
export function audioSecondsFromCount(count: unknown): number {
  const c = (count && typeof count === 'object' ? count : {}) as Record<string, unknown>;
  const details = Array.isArray(c.promptTokensDetails) ? (c.promptTokensDetails as Record<string, unknown>[]) : null;
  const audioTokens = details?.find((d) => String(d.modality).toUpperCase() === 'AUDIO');
  const tokens = audioTokens ? int(audioTokens.tokenCount) : int(c.totalTokens);
  return Math.round((tokens / AUDIO_TOKENS_PER_SECOND) * 100) / 100;
}

/**
 * Upper bound on upload size for a given maximum duration: 256 kbit/s (far above the
 * 32 kbit/s opus the app records, and above typical Safari AAC) plus container overhead.
 * The exact duration is measured afterwards with the free countTokens call.
 */
export function maxUploadBytes(maxSeconds: number): number {
  return Math.ceil(maxSeconds * 32_000 + 64 * 1024);
}

/** Refusal reasons from mvl_reserve_ai_capture → HTTP status for the client. */
export const REFUSAL_STATUS: Record<string, number> = {
  ai_paused: 503,
  ai_test_mode: 403,
  ai_price_unknown: 503,
  plan_unknown: 500,
  audio_too_long: 413,
  quota_captures: 429,
  quota_minutes: 429,
  rate_limited_hour: 429,
  rate_limited_day: 429,
  budget_daily: 503,
  budget_monthly: 503,
};

export function refusalStatus(reason: string): number {
  return REFUSAL_STATUS[reason] ?? 500;
}
