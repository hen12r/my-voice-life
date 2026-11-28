// Pure helpers for provider secrets (no Deno/browser APIs, tested with Vitest).
// 1. normaliseApiKey: read a key from the environment the way a person actually pastes it into
//    the Supabase dashboard (stray spaces, a trailing line break, surrounding quotes).
// 2. redactSecrets: keep keys and tokens out of logs and error messages, even when an upstream
//    error body echoes part of a key (OpenAI's "Incorrect API key provided: sk-…" message does).
// Neither function ever returns or logs the key itself in a warning.

export interface NormalisedKey {
  /** The usable key, or null when none is configured or it cannot be sent as a header. */
  key: string | null;
  /** Human-readable setup problems. Never contain the key or any part of it. */
  warnings: string[];
}

export function normaliseApiKey(raw: string | null | undefined, name = 'OPENAI_API_KEY'): NormalisedKey {
  if (raw == null) return { key: null, warnings: [] };
  const warnings: string[] = [];
  let key = raw.trim();
  if (key !== raw) warnings.push(`${name} had spaces or line breaks around it; they were ignored.`);
  const unquoted = key.replace(/^(["'])(.*)\1$/s, '$2').trim();
  if (unquoted !== key) {
    warnings.push(`${name} was wrapped in quotes; they were ignored.`);
    key = unquoted;
  }
  if (!key) return { key: null, warnings: [...warnings, `${name} is set but empty.`] };
  if (/\s/.test(key)) {
    // A header value cannot contain whitespace: every request would fail before reaching OpenAI.
    return { key: null, warnings: [...warnings, `${name} contains spaces or line breaks inside it; paste the key again as one line.`] };
  }
  if (!key.startsWith('sk-')) warnings.push(`${name} does not look like an OpenAI API key (they start with "sk-").`);
  return { key, warnings };
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_*.-]{4,}/g, 'sk-[redacted]'],                       // OpenAI / Stripe secret keys, masked or not
  [/\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, '[redacted-key]'],     // Stripe restricted/publishable keys
  [/\bwhsec_[A-Za-z0-9]{6,}/g, 'whsec_[redacted]'],                     // Stripe webhook secrets
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],            // any bearer token
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'], // JWTs (Supabase keys, sessions)
];

/** Removes anything that looks like a credential, then bounds the length for logs. */
export function redactSecrets(text: string, maxChars = 300): string {
  let out = String(text);
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}
