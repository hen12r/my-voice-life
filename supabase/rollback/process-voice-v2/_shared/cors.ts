// Pure origin matching (no Deno APIs) so it can be unit-tested.
// Entries are exact origins, or patterns where `*` matches one DNS label fragment
// (letters, digits, hyphens — never a dot), e.g. https://my-voice-life-*-henry7.vercel.app

/**
 * Used when the ALLOWED_ORIGINS secret is not set (it is not secret, but Supabase secret storage
 * may be unavailable). Covers this project's Vercel previews and local development. Before going
 * live, set ALLOWED_ORIGINS to the exact production domain, which overrides this default.
 */
export const DEFAULT_ALLOWED_ORIGINS = 'https://my-voice-life-*-henry7.vercel.app,http://localhost:3000';

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw || DEFAULT_ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*');
  return new RegExp(`^${escaped}$`);
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase();
  return allowed.some((entry) => {
    const e = entry.toLowerCase();
    if (e === '*') return false; // a bare wildcard is never honoured: list real origins
    return e.includes('*') ? patternToRegex(e).test(o) : e === o;
  });
}
