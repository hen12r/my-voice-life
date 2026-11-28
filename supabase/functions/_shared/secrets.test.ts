import { describe, expect, it } from 'vitest';
import { normaliseApiKey, redactSecrets } from './secrets.ts';

// Placeholder values only: none of these strings is, or was ever, a real key.
const FAKE = 'sk-proj-FAKEfakeFAKE0000placeholder';

describe('normaliseApiKey', () => {
  it('treats an unset secret as not configured, without warnings', () => {
    expect(normaliseApiKey(undefined)).toEqual({ key: null, warnings: [] });
    expect(normaliseApiKey(null)).toEqual({ key: null, warnings: [] });
  });

  it('accepts a clean key as is', () => {
    expect(normaliseApiKey(FAKE)).toEqual({ key: FAKE, warnings: [] });
  });

  it('ignores spaces, a trailing line break and surrounding quotes from pasting', () => {
    for (const pasted of [`  ${FAKE}\n`, `"${FAKE}"`, ` '${FAKE}' \r\n`]) {
      const r = normaliseApiKey(pasted);
      expect(r.key).toBe(FAKE);
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });

  it('refuses an empty value or one with whitespace inside (it could never be sent)', () => {
    expect(normaliseApiKey('   ').key).toBeNull();
    expect(normaliseApiKey('sk-proj-abc def').key).toBeNull();
    expect(normaliseApiKey('sk-proj-abc\ndef').warnings.join(' ')).toMatch(/one line/);
  });

  it('warns when the value does not look like an OpenAI key, but still uses it', () => {
    const r = normaliseApiKey('not-a-key-123');
    expect(r.key).toBe('not-a-key-123');
    expect(r.warnings.join(' ')).toMatch(/sk-/);
  });

  it('never puts any part of the key into a warning', () => {
    for (const pasted of [`  ${FAKE}\n`, `"${FAKE}"`, 'wrong-format-SECRETPART', 'sk-a b']) {
      for (const w of normaliseApiKey(pasted).warnings) {
        expect(w).not.toContain('FAKEfake');
        expect(w).not.toContain('SECRETPART');
      }
    }
  });
});

describe('redactSecrets', () => {
  it('removes a masked key echoed by an OpenAI 401 error body', () => {
    const body = '{"error":{"message":"Incorrect API key provided: sk-proj-****************************ab12. You can find your API key at https://platform.openai.com/account/api-keys."}}';
    const out = redactSecrets(body, 1000);
    expect(out).not.toContain('ab12');
    expect(out).toContain('sk-[redacted]');
    expect(out).toContain('Incorrect API key provided');
  });

  it('removes full keys, bearer tokens, JWTs and Stripe secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlcGxhY2Vob2xkZXI';
    const out = redactSecrets(`key ${FAKE} auth Bearer abc.def-123 jwt ${jwt} wh whsec_PLACEHOLDER123 rk rk_test_PLACEHOLDER123`, 1000);
    for (const leaked of ['FAKEfake', 'abc.def-123', jwt, 'PLACEHOLDER123']) expect(out).not.toContain(leaked);
  });

  it('leaves ordinary error text alone and bounds the length', () => {
    expect(redactSecrets('model_not_found: The model does not exist')).toBe('model_not_found: The model does not exist');
    expect(redactSecrets('x'.repeat(500), 300)).toHaveLength(301);
  });
});
