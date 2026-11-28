import { describe, expect, it } from 'vitest';
import { findPublicEnvProblems, jwtRole, looksSecret, mask } from './env-guard.mjs';

const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;

describe('env guard', () => {
  it('accepts the two public Supabase values', () => {
    expect(findPublicEnvProblems({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc', PATH: '/bin' })).toEqual([]);
  });
  it('accepts a legacy anon JWT but rejects a service_role JWT', () => {
    expect(jwtRole(jwt('anon'))).toBe('anon');
    expect(looksSecret(jwt('anon'))).toBe(false);
    expect(looksSecret(jwt('service_role'))).toBe(true);
  });
  it('rejects any VITE_GEMINI_API_KEY even if empty, and secret-looking values in allowed names', () => {
    expect(findPublicEnvProblems({ VITE_GEMINI_API_KEY: '' })).toHaveLength(1);
    expect(findPublicEnvProblems({ VITE_OPENAI_API_KEY: '' })).toHaveLength(1);
    expect(findPublicEnvProblems({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sk-proj-abc123' })[0]).toMatch(/secret/);
    expect(findPublicEnvProblems({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' })[0]).toMatch(/secret/);
    expect(findPublicEnvProblems({ VITE_SUPABASE_PUBLISHABLE_KEY: 'AIzaSyA1234567890abcdefghijklmn' })[0]).toMatch(/secret/);
  });
  it("tolerates Vercel's own VITE_VERCEL_* metadata, but still rejects secret-looking values there", () => {
    expect(findPublicEnvProblems({ VITE_VERCEL_GIT_COMMIT_SHA: 'e0150d7', VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG: '{"a":1}' })).toEqual([]);
    expect(findPublicEnvProblems({ VITE_VERCEL_SNEAKY: 'sb_secret_abc' })[0]).toMatch(/secret/);
    expect(findPublicEnvProblems({ VITE_VERCELX: 'x' })).toHaveLength(1);
    expect(findPublicEnvProblems({ VITE_GEMINI_API_KEY: '' })).toHaveLength(1);
  });
  it('ignores non-VITE variables (server secrets are allowed to exist in the build env)', () => {
    expect(findPublicEnvProblems({ GEMINI_API_KEY: 'AIzaSyA1234567890abcdefghijklmn' })).toEqual([]);
  });
  it('masks values', () => {
    expect(mask('sb_publishable_abcdefghijklmnop')).toBe('sb_publishab… (31 chars)');
    expect(mask('short')).toBe('***');
  });
});

describe('Stripe secrets', () => {
  it('treats Stripe secret, restricted and webhook keys as secrets', async () => {
    const { looksSecret } = await import('./env-guard.mjs');
    for (const v of ['sk_test_abc', 'sk_live_abc', 'rk_test_abc', 'rk_live_abc', 'whsec_abc']) expect(looksSecret(v)).toBe(true);
    expect(looksSecret('pk_test_abc')).toBe(false); // publishable keys are public by design (and unused here)
  });
});

