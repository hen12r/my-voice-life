// Shared by vite.config.ts (build guard), scripts/check-env.mjs and tests.
// Only these two variables may ever be exposed to the browser.
export const ALLOWED_PUBLIC_VARS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
// Vercel injects its own non-secret build metadata with the framework prefix
// (e.g. VITE_VERCEL_GIT_COMMIT_SHA, VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG), even when
// "automatically expose system environment variables" is off. These names are tolerated,
// but their values still go through the secret check below.
export const TOLERATED_PUBLIC_PREFIX = 'VITE_VERCEL_';

/** @param {string} value */
export function looksSecret(value) {
  if (!value) return false;
  if (value.startsWith('sb_secret_')) return true;            // Supabase secret API key
  if (/^AIza[0-9A-Za-z_-]{20,}/.test(value)) return true;     // Google / Gemini API key
  if (/^(sk|rk)[-_]/.test(value)) return true;                 // OpenAI / Stripe style secrets
  if (value.startsWith('whsec_')) return true;                 // Stripe webhook signing secret
  return jwtRole(value) === 'service_role';                    // legacy Supabase service key
}

/** @param {string} value @returns {string | null} */
export function jwtRole(value) {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json)?.role ?? null;
  } catch {
    return null;
  }
}

/** @param {Record<string, string | undefined>} env @returns {string[]} problems */
export function findPublicEnvProblems(env) {
  const problems = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VITE_')) continue;
    if (!ALLOWED_PUBLIC_VARS.includes(key) && !key.startsWith(TOLERATED_PUBLIC_PREFIX)) problems.push(`${key} is not an allowed public variable`);
    if (value && looksSecret(value)) problems.push(`${key} contains what looks like a secret key`);
  }
  return problems;
}

/** @param {Record<string, string | undefined>} env */
export function assertNoSecretsInPublicEnv(env) {
  const problems = findPublicEnvProblems(env);
  if (problems.length) {
    throw new Error(`Refusing to build: ${problems.join('; ')}. Secrets belong in Supabase Function Secrets, never in VITE_* variables.`);
  }
}

/** Masks a value for display: never prints more than a short prefix. @param {string} v */
export function mask(v) {
  if (!v) return '(empty)';
  return v.length <= 12 ? '***' : `${v.slice(0, 12)}… (${v.length} chars)`;
}
