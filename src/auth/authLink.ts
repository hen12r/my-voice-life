// Errors that Supabase Auth appends to redirect URLs when an email link (confirmation,
// password recovery, magic link) or an OAuth sign-in fails, e.g.
//   /app#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
// They are read once at start-up, removed from the address bar, and shown on the sign-in pages
// instead of silently landing the user on a login screen with no explanation.

export interface AuthLinkError { code: string; description: string }

const KNOWN = ['otp_expired', 'access_denied', 'validation_failed', 'bad_oauth_state', 'bad_oauth_callback', 'provider_email_needs_verification'];

export function parseAuthLinkError(hash: string, search: string): AuthLinkError | null {
  for (const raw of [hash.replace(/^#/, ''), search.replace(/^\?/, '')]) {
    if (!raw) continue;
    const p = new URLSearchParams(raw);
    const code = p.get('error_code') || p.get('error');
    if (!code) continue;
    return { code: KNOWN.includes(code) ? code : 'auth_link', description: (p.get('error_description') ?? '').slice(0, 200) };
  }
  return null;
}

/** Reads and strips an auth error from the current URL (call once, before routing). */
export function consumeAuthLinkError(): AuthLinkError | null {
  if (typeof window === 'undefined') return null;
  const err = parseAuthLinkError(window.location.hash, window.location.search);
  if (err) {
    const url = new URL(window.location.href);
    url.hash = '';
    for (const k of ['error', 'error_code', 'error_description']) url.searchParams.delete(k);
    window.history.replaceState(null, '', url.pathname + url.search);
  }
  return err;
}
