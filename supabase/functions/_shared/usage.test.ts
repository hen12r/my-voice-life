import { describe, expect, it } from 'vitest';
import { estimateCaptureSeconds, maxUploadBytes, parseResponsesUsage, refusalStatus, transcriptionSeconds } from './usage.ts';

const WORST = { inputTokens: 5000, outputTokens: 2048 };

describe('parseResponsesUsage', () => {
  it('splits reasoning tokens out of output tokens', () => {
    expect(parseResponsesUsage({ input_tokens: 900, output_tokens: 150, output_tokens_details: { reasoning_tokens: 40 } }, WORST))
      .toEqual({ audio_tokens: 0, text_in_tokens: 900, output_tokens: 110, thinking_tokens: 40 });
  });
  it('books cached input at the full rate (never under-counts)', () => {
    expect(parseResponsesUsage({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 10 }, WORST).text_in_tokens).toBe(1000);
  });
  it('books the worst case when usage is missing', () => {
    expect(parseResponsesUsage(undefined, WORST)).toEqual({ audio_tokens: 0, text_in_tokens: 5000, output_tokens: 2048, thinking_tokens: 0 });
  });
  it('ignores negative or non-numeric values', () => {
    expect(parseResponsesUsage({ input_tokens: -5, output_tokens: 'x' }, WORST)).toEqual({ audio_tokens: 0, text_in_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
  });
});

describe('transcriptionSeconds', () => {
  it('uses the duration the provider billed', () => {
    expect(transcriptionSeconds({ type: 'duration', seconds: 12.345 }, 99)).toEqual({ seconds: 12.35, reported: true });
  });
  it('falls back to the server-measured length when only tokens are reported', () => {
    expect(transcriptionSeconds({ type: 'tokens', input_tokens: 60 }, 7.5)).toEqual({ seconds: 7.5, reported: false });
    expect(transcriptionSeconds(null, 3)).toEqual({ seconds: 3, reported: false });
  });
});

describe('estimateCaptureSeconds', () => {
  it('prefers the container duration and lets the client claim only increase it', () => {
    expect(estimateCaptureSeconds({ parsedSeconds: 60, declaredMs: 2000, bytes: 52_000 })).toEqual({ seconds: 60, verified: true });
    expect(estimateCaptureSeconds({ parsedSeconds: 3.96, declaredMs: 30_000, bytes: 16_000 })).toEqual({ seconds: 30, verified: true });
  });
  it('falls back to a byte-based bound when the container cannot be parsed', () => {
    expect(estimateCaptureSeconds({ parsedSeconds: null, declaredMs: 1000, bytes: 80_000 })).toEqual({ seconds: 10, verified: false });
    expect(estimateCaptureSeconds({ parsedSeconds: null, declaredMs: 20_000, bytes: 80_000 })).toEqual({ seconds: 20, verified: false });
  });
});

describe('limits', () => {
  it('bounds upload size generously above the recording bitrate, below the 25 MB provider limit', () => {
    expect(maxUploadBytes(120)).toBe(120 * 32_000 + 65_536);
    expect(maxUploadBytes(120)).toBeGreaterThan(120 * 4_000 * 4);
    expect(maxUploadBytes(600)).toBeLessThan(25 * 1024 * 1024);
  });
  it('maps refusal reasons to HTTP statuses', () => {
    expect(refusalStatus('quota_captures')).toBe(429);
    expect(refusalStatus('budget_daily')).toBe(503);
    expect(refusalStatus('ai_test_mode')).toBe(403);
    expect(refusalStatus('audio_too_long')).toBe(413);
    expect(refusalStatus('something_new')).toBe(500);
  });
});
