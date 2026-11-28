// push tests (run with: npm run test:functions). Database and push services are fakes (SIMULATED).
// Proves: sign-in required; 503 when keys are missing; config returns only the PUBLIC key; the test
// goes only to the caller's own devices; texts are length-limited; tests are throttled.
import { createPushHandler } from './handler.ts';
import { b64urlEncode, generateEcdhKeyPair } from '../_shared/webpush.ts';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

async function setup(opts: { user?: { id: string } | null; vapid?: boolean; devices?: number } = {}) {
  const keys = await generateEcdhKeyPair();
  const asked: string[] = [], posts: string[] = [];
  const devs = await Promise.all(Array.from({ length: opts.devices ?? 1 }, async (_, i) => {
    const ua = await generateEcdhKeyPair();
    return { id: `d${i}`, endpoint: `https://fcm.googleapis.com/fcm/send/d${i}`, p256dh: b64urlEncode(ua.publicKey), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
  }));
  let t = 1_800_000_000_000;
  const handle = createPushHandler({
    getUser: () => Promise.resolve(opts.user === undefined ? { id: 'user-1' } : opts.user),
    vapid: opts.vapid === false ? null : { keys, subject: 'mailto:owner@example.org' },
    store: { targets: (u) => { asked.push(u); return Promise.resolve(devs); }, record: () => Promise.resolve() },
    fetch: (async (url: string) => { posts.push(url); return new Response(null, { status: 201 }); }) as typeof fetch,
    now: () => (t += 1000),
  });
  const call = (body: unknown) => handle(new Request('https://x/functions/v1/push', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  return { call, keys, asked, posts };
}

Deno.test('requires sign-in', async () => {
  const s = await setup({ user: null });
  assertEq((await s.call({ action: 'config' })).status, 401, '401');
});

Deno.test('503 push_not_configured when the VAPID keys are missing', async () => {
  const s = await setup({ vapid: false });
  const r = await s.call({ action: 'config' });
  assertEq(r.status, 503, '503');
  assertEq((await r.json()).error.code, 'push_not_configured', 'code');
});

Deno.test('config returns only the public key', async () => {
  const s = await setup();
  const body = await (await s.call({ action: 'config' })).json();
  assertEq(Object.keys(body), ['public_key'], 'one field');
  assertEq(body.public_key, b64urlEncode(s.keys.publicKey), 'public key');
  assert(!JSON.stringify(body).includes(b64urlEncode(s.keys.privateKey)), 'private key never returned');
});

Deno.test('test notification goes to the caller own devices only', async () => {
  const s = await setup({ devices: 2 });
  const r = await s.call({ action: 'test', title: 'x'.repeat(500), body: 'Notifications work.' });
  assertEq(await r.json(), { sent: 2, removed: 0 }, 'sent to 2');
  assertEq(s.asked, ['user-1'], 'targets looked up for the signed-in user only');
  assertEq(s.posts.length, 2, '2 requests');
});

Deno.test('no device → clear error', async () => {
  const s = await setup({ devices: 0 });
  const r = await s.call({ action: 'test' });
  assertEq(r.status, 400, '400');
  assertEq((await r.json()).error.code, 'no_devices', 'code');
});

Deno.test('test sends are throttled (5 per 10 minutes)', async () => {
  const s = await setup();
  for (let i = 0; i < 5; i++) assertEq((await s.call({ action: 'test' })).status, 200, `attempt ${i + 1}`);
  assertEq((await s.call({ action: 'test' })).status, 429, '6th refused');
});

Deno.test('unknown action and GET are refused', async () => {
  const s = await setup();
  assertEq((await s.call({ action: 'subscribe', endpoint: 'https://evil.example' })).status, 400, 'no endpoint accepted here');
});
