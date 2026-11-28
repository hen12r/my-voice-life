// Which sign-in providers the Supabase project actually has enabled, read from GoTrue's public
// GET /auth/v1/settings (needs only the publishable key). Used so the app never shows a sign-in
// button that cannot work: when Google is disabled in Supabase, the authorize request returns a
// raw JSON error page ("provider is not enabled") instead of coming back to the app.

/** `true` / `false` when the settings say so; `null` when unknown (then the button is shown). */
export function googleEnabledFromSettings(settings: unknown): boolean | null {
  if (!settings || typeof settings !== 'object') return null;
  const external = (settings as { external?: unknown }).external;
  if (!external || typeof external !== 'object') return null;
  const g = (external as Record<string, unknown>).google;
  return typeof g === 'boolean' ? g : null;
}

let cached: Promise<boolean | null> | null = null;

export function fetchGoogleEnabled(supabaseUrl: string | undefined, publishableKey: string | undefined, f: typeof fetch = fetch): Promise<boolean | null> {
  if (!supabaseUrl || !publishableKey) return Promise.resolve(null);
  cached ??= f(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: publishableKey } })
    .then((r) => (r.ok ? r.json() : null))
    .then(googleEnabledFromSettings)
    .catch(() => null);
  return cached;
}

/** For tests only. */
export function resetProviderCache() { cached = null; }
