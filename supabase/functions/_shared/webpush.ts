// Web Push, implemented with WebCrypto only (no dependency), so the same code runs in Deno (Edge
// Functions) and in Node/the browser (tests).
//  - Message encryption: RFC 8291 (aes128gcm, RFC 8188). The push service only ever sees ciphertext;
//    only the user's browser can decrypt the reminder title.
//  - Server identification: VAPID, RFC 8292 (ES256 JWT).
//  - SSRF guard: we only ever POST to the known push services of the major browsers.
// Verified against the RFC 8291 Appendix A test vector (webpush.test.ts).

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** Copies into a fresh ArrayBuffer-backed array (what WebCrypto's typings expect). */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => { const c = new Uint8Array(new ArrayBuffer(u.length)); c.set(u); return c; };

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

/** P-256 public key as 65 raw bytes (0x04 || x || y) → JWK coordinates. */
function pointToJwk(pub: Uint8Array): { x: string; y: string } {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('invalid P-256 public key');
  return { x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)) };
}

export interface RawKeyPair { publicKey: Uint8Array; privateKey: Uint8Array } // 65-byte point, 32-byte scalar

async function importPrivate(kp: RawKeyPair, alg: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  if (kp.privateKey.length !== 32) throw new Error('invalid P-256 private key');
  const jwk = { kty: 'EC', crv: 'P-256', ...pointToJwk(kp.publicKey), d: b64urlEncode(kp.privateKey), ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: alg, namedCurve: 'P-256' }, false, alg === 'ECDH' ? ['deriveBits'] : ['sign']);
}

export async function generateEcdhKeyPair(): Promise<RawKeyPair> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey, privateKey: b64urlDecode(jwk.d!) };
}

/**
 * Encrypts a push message for one subscription (RFC 8291, single record, record size 4096).
 * `salt` and `asKeys` are only passed by tests (RFC vector); normally they are fresh and random.
 */
export async function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
  opts: { salt?: Uint8Array; asKeys?: RawKeyPair } = {}): Promise<Uint8Array> {
  if (authSecret.length !== 16) throw new Error('invalid auth secret');
  if (plaintext.length > 3993) throw new Error('payload too large'); // 4096 − header-free record overhead
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = opts.asKeys ?? await generateEcdhKeyPair();
  const asPriv = await importPrivate(as, 'ECDH');
  const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, as.publicKey);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(concat(plaintext, new Uint8Array([2])))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096, big-endian
  return concat(salt, rs, new Uint8Array([as.publicKey.length]), as.publicKey, ct);
}

/** VAPID (RFC 8292): an ES256 JWT for the push service's origin, valid 12 hours. */
export async function vapidAuthorization(endpoint: string, vapid: RawKeyPair, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await importPrivate(vapid, 'ECDSA');
  // WebCrypto returns the raw r||s signature, which is exactly the JOSE ES256 format.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${b64urlEncode(vapid.publicKey)}`;
}

// Push services of the major browsers. Anything else is refused, so a stored "endpoint" can never
// make our server call an arbitrary URL (SSRF).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && PUSH_HOSTS.some((h) => h.test(u.hostname)) && endpoint.length <= 1000;
  } catch { return false; }
}

export interface PushSubscriptionRow { id: string; endpoint: string; p256dh: string; auth: string }
export interface PushResult { id: string; ok: boolean; gone: boolean; status: number }

/** Sends one encrypted message. 404/410 from the push service = the subscription no longer exists. */
export async function sendPush(sub: PushSubscriptionRow, payload: unknown, vapid: { keys: RawKeyPair; subject: string },
  fetchFn: typeof fetch = fetch, ttlSeconds = 4 * 3600): Promise<PushResult> {
  if (!isAllowedEndpoint(sub.endpoint)) return { id: sub.id, ok: false, gone: true, status: 0 };
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), b64urlDecode(sub.p256dh), b64urlDecode(sub.auth));
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid.keys, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
      Urgency: 'high',
    },
    body: buf(body),
  });
  await res.body?.cancel().catch(() => undefined);
  return { id: sub.id, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

/** Reads the VAPID key pair from its two base64url strings (from Edge Function secrets). */
export function parseVapidKeys(publicKey: string | undefined, privateKey: string | undefined): RawKeyPair | null {
  if (!publicKey || !privateKey) return null;
  try {
    const kp = { publicKey: b64urlDecode(publicKey.trim()), privateKey: b64urlDecode(privateKey.trim()) };
    pointToJwk(kp.publicKey);
    return kp.privateKey.length === 32 ? kp : null;
  } catch { return null; }
}
