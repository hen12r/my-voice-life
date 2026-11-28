import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, encryptPayload, generateEcdhKeyPair, isAllowedEndpoint, parseVapidKeys, sendPush, vapidAuthorization } from './webpush.ts';

// RFC 8291, Appendix A (copied from rfc-editor.org/rfc/rfc8291.txt; whitespace from line wrapping removed).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

/** Decrypts like a browser would, using the user agent's private key (test only). */
async function decrypt(body: Uint8Array, uaPublic: Uint8Array, uaPrivate: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16); const idlen = body[20]; const asPublic = body.slice(21, 21 + idlen); const ct = body.slice(21 + idlen);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64urlEncode(uaPublic.slice(1, 33)), y: b64urlEncode(uaPublic.slice(33)), d: b64urlEncode(uaPrivate) };
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const h = async (k: Uint8Array, d: Uint8Array) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
  const te = new TextEncoder(); const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const ikm = await h(await h(auth, ecdh), cat(te.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await h(salt, ikm);
  const cek = (await h(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await h(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
  expect(pt[pt.length - 1]).toBe(2); // padding delimiter
  return new TextDecoder().decode(pt.slice(0, -1));
}

describe('web push encryption (RFC 8291)', () => {
  it('reproduces the RFC 8291 Appendix A message byte for byte', async () => {
    const body = await encryptPayload(b64urlDecode(RFC.plaintext), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.auth),
      { salt: b64urlDecode(RFC.salt), asKeys: { publicKey: b64urlDecode(RFC.asPublic), privateKey: b64urlDecode(RFC.asPrivate) } });
    expect(b64urlEncode(body.slice(0, 86))).toBe(RFC.header);
    expect(b64urlEncode(body.slice(86))).toBe(RFC.ciphertext);
  });
  it('a fresh message (random salt and key) decrypts back for the browser only', async () => {
    const ua = await generateEcdhKeyPair(); const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify({ title: 'Call the school', time: '09:00' });
    const body = await encryptPayload(new TextEncoder().encode(msg), ua.publicKey, auth);
    expect(await decrypt(body, ua.publicKey, ua.privateKey, auth)).toBe(msg);
    expect(new TextDecoder().decode(body)).not.toContain('Call the school');
  });
  it('rejects malformed keys and oversized payloads', async () => {
    const ua = await generateEcdhKeyPair();
    await expect(encryptPayload(new Uint8Array(10), ua.publicKey, new Uint8Array(5))).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(5000), ua.publicKey, new Uint8Array(16))).rejects.toThrow('payload too large');
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the push service origin that verifies with the public key', async () => {
    const kp = await generateEcdhKeyPair(); // same curve; reused as an ECDSA key
    const auth = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', kp, 'mailto:owner@example.org', 1_800_000_000);
    const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m).toBeTruthy();
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])))).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:owner@example.org' });
    expect(m[4]).toBe(b64urlEncode(kp.publicKey));
    const pub = await crypto.subtle.importKey('raw', kp.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
  it('parses keys from secrets and refuses bad ones', async () => {
    const kp = await generateEcdhKeyPair();
    expect(parseVapidKeys(b64urlEncode(kp.publicKey), b64urlEncode(kp.privateKey))).not.toBeNull();
    expect(parseVapidKeys(undefined, 'x')).toBeNull();
    expect(parseVapidKeys('abc', b64urlEncode(kp.privateKey))).toBeNull();
  });
});

describe('endpoint allow-list (SSRF guard)', () => {
  it('accepts only the major browsers’ push services over https', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
      expect(isAllowedEndpoint(ok)).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'not a url', `https://fcm.googleapis.com/${'a'.repeat(1001)}`])
      expect(isAllowedEndpoint(bad)).toBe(false);
  });
  it('never calls a disallowed endpoint', async () => {
    let called = false;
    const vapid = { keys: await generateEcdhKeyPair(), subject: 'mailto:o@example.org' };
    const r = await sendPush({ id: 's', endpoint: 'https://evil.example/x', p256dh: 'x', auth: 'x' }, {}, vapid, (async () => { called = true; return new Response(null); }) as typeof fetch);
    expect(called).toBe(false);
    expect(r).toEqual({ id: 's', ok: false, gone: true, status: 0 });
  });
  it('reports 410 as gone and 201 as ok', async () => {
    const ua = await generateEcdhKeyPair();
    const sub = { id: 's', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: b64urlEncode(ua.publicKey), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
    const vapid = { keys: await generateEcdhKeyPair(), subject: 'mailto:o@example.org' };
    let headers: Headers | undefined;
    const ok = await sendPush(sub, { t: 1 }, vapid, (async (_u: string, init: RequestInit) => { headers = new Headers(init.headers); return new Response(null, { status: 201 }); }) as typeof fetch);
    expect(ok).toEqual({ id: 's', ok: true, gone: false, status: 201 });
    expect(headers!.get('Content-Encoding')).toBe('aes128gcm');
    expect(headers!.get('Authorization')).toMatch(/^vapid t=/);
    const gone = await sendPush(sub, { t: 1 }, vapid, (async () => new Response(null, { status: 410 })) as typeof fetch);
    expect(gone.gone).toBe(true);
  });
});
