import { describe, expect, it } from 'vitest';
import { parseAuthLinkError } from './authLink';

describe('parseAuthLinkError', () => {
  it('reads an expired email link from the hash (implicit flow)', () => {
    expect(parseAuthLinkError('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', ''))
      .toEqual({ code: 'otp_expired', description: 'Email link is invalid or has expired' });
  });
  it('reads errors from the query string (PKCE / OAuth)', () => {
    expect(parseAuthLinkError('', '?error=access_denied&error_description=denied')?.code).toBe('access_denied');
  });
  it('maps unknown codes to a generic link error', () => {
    expect(parseAuthLinkError('#error_code=something_new', '')?.code).toBe('auth_link');
  });
  it('ignores normal URLs and successful sign-in tokens', () => {
    expect(parseAuthLinkError('', '')).toBeNull();
    expect(parseAuthLinkError('#access_token=abc&type=recovery', '')).toBeNull();
  });
});
