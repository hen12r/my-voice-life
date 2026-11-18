import { describe, expect, it } from 'vitest';
import { audioSecondsFromCount, maxUploadBytes, parseUsageMetadata, refusalStatus } from './usage.ts';

describe('parseUsageMetadata', () => {
  it('splits audio and text prompt tokens and reads output + thinking', () => {
    const u = parseUsageMetadata({
      promptTokenCount: 1010, candidatesTokenCount: 150, thoughtsTokenCount: 12,
      promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }, { modality: 'TEXT', tokenCount: 50 }],
    }, true);
    expect(u).toEqual({ audio_tokens: 960, text_in_tokens: 50, output_tokens: 150, thinking_tokens: 12 });
  });
  it('books tokens missing from the breakdown at the audio rate when the call had audio', () => {
    const u = parseUsageMetadata({ promptTokenCount: 1000, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }] }, true);
    expect(u.audio_tokens).toBe(960);
  });
  it('without a breakdown, books all prompt tokens as audio for audio calls and text otherwise', () => {
    expect(parseUsageMetadata({ promptTokenCount: 500 }, true).audio_tokens).toBe(500);
    expect(parseUsageMetadata({ promptTokenCount: 500 }, false).text_in_tokens).toBe(500);
  });
  it('treats missing/invalid values as zero, never negative', () => {
    expect(parseUsageMetadata(undefined, false)).toEqual({ audio_tokens: 0, text_in_tokens: 0, output_tokens: 0, thinking_tokens: 0 });
    expect(parseUsageMetadata({ candidatesTokenCount: -5, thoughtsTokenCount: 'x' }, false).output_tokens).toBe(0);
  });
});

describe('audio length and limits', () => {
  it('derives seconds from countTokens (32 tokens/s)', () => {
    expect(audioSecondsFromCount({ totalTokens: 1920 })).toBe(60);
    expect(audioSecondsFromCount({ totalTokens: 2000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 960 }] })).toBe(30);
  });
  it('bounds upload size generously above the recording bitrate', () => {
    expect(maxUploadBytes(120)).toBe(120 * 32_000 + 65_536);
    expect(maxUploadBytes(120)).toBeGreaterThan(120 * 4_000 * 4); // 4x the 32 kbit/s opus size
  });
  it('maps refusal reasons to HTTP statuses', () => {
    expect(refusalStatus('quota_captures')).toBe(429);
    expect(refusalStatus('budget_daily')).toBe(503);
    expect(refusalStatus('ai_test_mode')).toBe(403);
    expect(refusalStatus('audio_too_long')).toBe(413);
    expect(refusalStatus('something_new')).toBe(500);
  });
});
