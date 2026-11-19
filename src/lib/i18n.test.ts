import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorMessage, translate, type TranslationKey } from './i18n';
import { REFUSAL_STATUS } from '../../supabase/functions/_shared/usage.ts';

// Every error code the backend can return: read from the handler's source so the list cannot
// drift, plus the refusal reasons from the usage controls.
const handlerSource = readFileSync(new URL('../../supabase/functions/process-voice/handler.ts', import.meta.url), 'utf8');
const HANDLER_CODES = [...handlerSource.matchAll(/(?:fail\(req, \d+|InputError\(\d+), '([a-z_]+)'/g)].map((m) => m[1]);
// Not reachable from the app: the UI never sends empty text, and always uses POST.
const UNREACHABLE = ['no_text', 'method_not_allowed'];
const ALL_CODES = [...new Set([...HANDLER_CODES, ...Object.keys(REFUSAL_STATUS)])].filter((c) => !UNREACHABLE.includes(c));

describe('error messages', () => {
  it('finds the handler codes (sanity check of the extraction)', () => {
    expect(HANDLER_CODES).toContain('ai_not_configured');
    expect(HANDLER_CODES).toContain('unsupported_audio');
    expect(HANDLER_CODES.length).toBeGreaterThan(12);
  });
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
