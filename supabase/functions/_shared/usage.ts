// Pure helpers for AI usage accounting (no Deno/browser APIs) — shared and unit-tested.

export interface CallUsage {
  audio_tokens: number;
  text_in_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * Converts an OpenAI Responses API `usage` object into the ledger's token buckets.
 * `output_tokens` includes reasoning tokens, which are split out as thinking tokens (same rate).
 * Cached input tokens are billed by OpenAI at a discount but are booked here at the full input
 * rate, so costs are never under-estimated. If `usage` is missing, the worst case is booked.
 */
export function parseResponsesUsage(usage: unknown, worstCase: { inputTokens: number; outputTokens: number }): CallUsage {
  const u = obj(usage);
  if (!('input_tokens' in u) && !('output_tokens' in u)) {
    return { audio_tokens: 0, text_in_tokens: worstCase.inputTokens, output_tokens: worstCase.outputTokens, thinking_tokens: 0 };
  }
  const output = int(u.output_tokens);
  const reasoning = Math.min(output, int(obj(u.output_tokens_details).reasoning_tokens));
  return { audio_tokens: 0, text_in_tokens: int(u.input_tokens), output_tokens: output - reasoning, thinking_tokens: reasoning };
}

/**
 * Seconds billed for a transcription. OpenAI reports either `{type: "duration", seconds}` or a
 * token breakdown; per-minute models are billed on duration, so when no duration is reported the
 * server-side measured length (always >= the real length) is used instead.
 */
export function transcriptionSeconds(usage: unknown, measuredSeconds: number): { seconds: number; reported: boolean } {
  const u = obj(usage);
  if (u.type === 'duration' && typeof u.seconds === 'number' && Number.isFinite(u.seconds) && u.seconds > 0) {
    return { seconds: Math.round(u.seconds * 100) / 100, reported: true };
  }
  return { seconds: measuredSeconds, reported: false };
}

/**
 * Bytes per second assumed when the container cannot be parsed: 64 kbit/s. A real recording at
 * the app's 32 kbit/s is then estimated at half its length, so the client's declared duration
 * dominates; the true duration reported by the provider is recorded afterwards.
 */
export const FALLBACK_BYTES_PER_SECOND = 8_000;

/**
 * Audio length used for the allowance check and the budget hold, decided BEFORE any paid call.
 * The container's own timing is preferred; the client's claim can only make it longer.
 */
export function estimateCaptureSeconds(args: { parsedSeconds: number | null; declaredMs: number; bytes: number }): { seconds: number; verified: boolean } {
  const declared = Math.max(0, args.declaredMs) / 1000;
  if (args.parsedSeconds !== null && args.parsedSeconds > 0) {
    return { seconds: round2(Math.max(args.parsedSeconds, declared)), verified: true };
  }
  return { seconds: round2(Math.max(declared, args.bytes / FALLBACK_BYTES_PER_SECOND)), verified: false };
}

const round2 = (n: number) => Math.ceil(n * 100) / 100;

/**
 * Upper bound on upload size for a given maximum duration: 256 kbit/s (far above the 32 kbit/s
 * opus the app records, and above typical Safari AAC) plus container overhead. Stays below the
 * provider's 25 MB file limit for the absolute maximum of 600 s.
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
