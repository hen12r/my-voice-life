// send-reminders tests (run with: npm run test:functions). The database and push services are
// recording fakes (SIMULATED). Proves: the cron secret is required (constant-time compare); nothing
// is claimed when keys are missing; one encrypted message per device; gone devices are removed;
// failures are counted; logs contain counts only (no title, endpoint or user id).
import { createSendHandler, type DueReminder, safeEqual, type Target } from './handler.ts';
import { b64urlEncode, generateEcdhKeyPair } from '../_shared/webpush.ts';

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
const SECRET = 'test-cron-secret-0123456789abcdef-PLACEHOLDER';

async function device(id: string, owner: string, host = 'fcm.googleapis.com'): Promise<Target> {
  const ua = await generateEcdhKeyPair();
  return { id, owner_id: owner, endpoint: `https://${host}/fcm/send/${id}`, p256dh: b64urlEncode(ua.publicKey), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

async function setup(opts: { secret?: string; vapid?: boolean; due?: DueReminder[]; targets?: Target[]; status?: (url: string) => number } = {}) {
  const claims: number[] = [], records: [string, boolean, boolean][] = [], posts: { url: string; body: Uint8Array; headers: Headers }[] = [], logs: string[] = [];
  const vapid = opts.vapid === false ? null : { keys: await generateEcdhKeyPair(), subject: 'mailto:owner@example.org' };
  const handle = createSendHandler({
    cronSecret: opts.secret === undefined ? SECRET : opts.secret,
    vapid,
    db: {
      claimDue: (n) => { claims.push(n); return Promise.resolve(opts.due ?? []); },
      targets: (ids) => Promise.resolve((opts.targets ?? []).filter((t) => ids.includes(t.owner_id))),
      record: (id, ok, gone) => { records.push([id, ok, gone]); return Promise.resolve(); },
    },
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, body: new Uint8Array(init.body as ArrayBuffer), headers: new Headers(init.headers) });
      return new Response(null, { status: opts.status?.(url) ?? 201 });
    }) as typeof fetch,
    log: (m) => logs.push(m),
  });
  const call = (headers: Record<string, string> = { 'x-mvl-cron': SECRET }, method = 'POST') => handle(new Request('https://x/functions/v1/send-reminders', { method, headers }));
  return { handle, call, claims, records, posts, logs };
}

const due = (id: string, owner: string, title = 'Call the school'): DueReminder => ({ reminder_id: id, owner_id: owner, title, remind_at: '2026-11-28T09:00:00Z', timezone: 'Africa/Kigali' });

Deno.test('constant-time compare', () => {
  assert(safeEqual('abc', 'abc'), 'equal');
  assert(!safeEqual('abc', 'abd'), 'different');
  assert(!safeEqual('abc', 'abcd'), 'length');
});

Deno.test('refuses without the right cron secret, and never claims', async () => {
  const s = await setup();
  assertEq((await s.call({})).status, 401, 'missing header');
  assertEq((await s.call({ 'x-mvl-cron': SECRET + 'x' })).status, 401, 'wrong secret');
  assertEq((await s.call({ 'x-mvl-cron': SECRET }, 'GET')).status, 405, 'GET');
  assertEq(s.claims.length, 0, 'nothing claimed');
});

Deno.test('refuses when the cron secret is unset or too short', async () => {
  for (const secret of ['', 'short']) {
    const s = await setup({ secret });
    assertEq((await s.call({ 'x-mvl-cron': secret })).status, 503, `secret "${secret}"`);
    assertEq(s.claims.length, 0, 'nothing claimed');
  }
});

Deno.test('refuses BEFORE claiming when VAPID keys are missing (no reminder marked sent unsent)', async () => {
  const s = await setup({ vapid: false, due: [due('r1', 'u1')] });
  assertEq((await s.call()).status, 503, 'push_not_configured');
  assertEq(s.claims.length, 0, 'nothing claimed');
});

Deno.test('sends one encrypted message per device of the owner; logs counts only', async () => {
  const targets = [await device('d1', 'u1'), await device('d2', 'u1'), await device('d3', 'u2')];
  const s = await setup({ due: [due('r1', 'u1', 'Secret dentist appointment')], targets });
  const res = await s.call();
  assertEq(res.status, 200, 'ok');
  assertEq(await res.json(), { claimed: 1, sent: 2, failed: 0, removed: 0 }, 'summary');
  assertEq(s.posts.map((p) => p.url).sort(), ['https://fcm.googleapis.com/fcm/send/d1', 'https://fcm.googleapis.com/fcm/send/d2'], 'only u1 devices');
  for (const p of s.posts) {
    assertEq(p.headers.get('Content-Encoding'), 'aes128gcm', 'encrypted');
    assert(!new TextDecoder().decode(p.body).includes('dentist'), 'title never in clear text');
    assert(p.headers.get('Authorization')!.startsWith('vapid t='), 'VAPID');
  }
  assertEq(s.records.map((r) => r[1]), [true, true], 'success recorded');
  const all = s.logs.join('\n');
  assert(!all.includes('dentist') && !all.includes('fcm.googleapis') && !all.includes('u1'), 'logs contain no title, endpoint or user id');
  assert(all.includes('claimed=1 sent=2'), 'counts logged');
});

Deno.test('a gone device (410) is removed; other failures are counted', async () => {
  const targets = [await device('gone', 'u1'), await device('err', 'u1'), await device('ok', 'u1')];
  const s = await setup({ due: [due('r1', 'u1')], targets, status: (u) => (u.endsWith('/gone') ? 410 : u.endsWith('/err') ? 500 : 201) });
  assertEq(await (await s.call()).json(), { claimed: 1, sent: 1, failed: 1, removed: 1 }, 'summary');
  assertEq(s.records.find((r) => r[0] === 'gone'), ['gone', false, true], 'gone → delete');
  assertEq(s.records.find((r) => r[0] === 'err'), ['err', false, false], 'error → counted');
});

Deno.test('a stored endpoint outside the push services is never called', async () => {
  const bad = { ...(await device('bad', 'u1')), endpoint: 'https://169.254.169.254/latest/meta-data' };
  const s = await setup({ due: [due('r1', 'u1')], targets: [bad] });
  assertEq(await (await s.call()).json(), { claimed: 1, sent: 0, failed: 0, removed: 1 }, 'treated as gone');
  assertEq(s.posts.length, 0, 'no request made');
});

Deno.test('nothing due → nothing sent', async () => {
  const s = await setup({ due: [] });
  assertEq(await (await s.call()).json(), { claimed: 0, sent: 0, failed: 0, removed: 0 }, 'summary');
  assertEq(s.posts.length, 0, 'no request');
});
