import { describe, expect, it } from 'vitest';
import { errorMessage, translate, type TranslationKey } from './i18n';
import { REFUSAL_STATUS } from '../../supabase/functions/_shared/usage.ts';

// Every error code the backend can return (process-voice handler + refusal reasons).
const HANDLER_CODES = ['ai_not_configured', 'unauthorized', 'no_audio', 'empty_audio', 'audio_too_long', 'unsupported_audio',
  'no_text', 'no_speech', 'ai_unavailable', 'accounting_unavailable', 'ai_busy', 'ai_rejected_input', 'ai_timeout', 'internal'];
const ALL_CODES = [...new Set([...HANDLER_CODES, ...Object.keys(REFUSAL_STATUS)])].filter((c) => c !== 'no_text'); // no_text cannot reach users (UI disables empty submit)

describe('error messages', () => {
  it('every backend error code has an English and a French message', () => {
    const missing = ALL_CODES.filter((c) => !translate('en', `errors.${c}` as TranslationKey) || !translate('fr', `errors.${c}` as TranslationKey));
    expect(missing).toEqual([]);
  });
  it('French messages differ from English (actually translated)', () => {
    const untranslated = ALL_CODES.filter((c) => translate('en', `errors.${c}` as TranslationKey) === translate('fr', `errors.${c}` as TranslationKey));
    expect(untranslated).toEqual([]);
  });
  it('maps an API error code to the translated message', () => {
    const t = (k: TranslationKey) => translate('fr', k);
    expect(errorMessage(t, { code: 'quota_captures', message: 'refused' })).toBe(translate('fr', 'errors.quota_captures'));
  });
  it('maps network failures and hides long technical messages', () => {
    const t = (k: TranslationKey) => translate('en', k);
    expect(errorMessage(t, new Error('Failed to fetch'))).toBe(translate('en', 'errors.network'));
    expect(errorMessage(t, new Error('x'.repeat(500)))).toBe(translate('en', 'errors.generic'));
  });
});
