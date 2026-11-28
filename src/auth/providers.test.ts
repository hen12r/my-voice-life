import { beforeEach, describe, expect, it } from 'vitest';
import { fetchGoogleEnabled, googleEnabledFromSettings, resetProviderCache } from './providers';

describe('Google provider detection', () => {
  beforeEach(() => resetProviderCache());
  it('reads external.google from the Supabase auth settings', () => {
    expect(googleEnabledFromSettings({ external: { google: false, email: true } })).toBe(false);
    expect(googleEnabledFromSettings({ external: { google: true } })).toBe(true);
  });
  it('is unknown (null) when the answer is missing or malformed', () => {
    expect(googleEnabledFromSettings(null)).toBeNull();
    expect(googleEnabledFromSettings({})).toBeNull();
    expect(googleEnabledFromSettings({ external: { google: 'yes' } })).toBeNull();
  });
  it('calls the public settings endpoint with only the publishable key, once', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = ((url: string, init?: RequestInit) => { calls.push([url, init]); return Promise.resolve(new Response(JSON.stringify({ external: { google: false } }))); }) as unknown as typeof fetch;
    expect(await fetchGoogleEnabled('https://x.supabase.co', 'sb_publishable_k', f)).toBe(false);
    expect(await fetchGoogleEnabled('https://x.supabase.co', 'sb_publishable_k', f)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://x.supabase.co/auth/v1/settings');
    expect(new Headers(calls[0][1]?.headers).get('apikey')).toBe('sb_publishable_k');
  });
  it('network failure → unknown, never an exception', async () => {
    const f = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await fetchGoogleEnabled('https://x.supabase.co', 'k', f)).toBeNull();
  });
});
