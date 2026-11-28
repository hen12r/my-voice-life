// delete-account tests (run with: npm run test:functions): a deleted user must never keep paying.
import { type StripeClient, StripeApiError } from '../_shared/stripe.ts';
import { createDeleteHandler } from './handler.ts';

function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

function setup(sub: { status: string; stripe_subscription_id: string | null } | null, stripe: 'ok' | 'fail' | '404' | 'none' = 'ok') {
  const dels: string[] = [];
  const deleted: string[] = [];
  const client: StripeClient = {
    get: () => Promise.reject(new Error('unexpected')),
    post: () => Promise.reject(new Error('unexpected')),
    del(path) {
      dels.push(path);
      if (stripe === 'fail') return Promise.reject(new StripeApiError(500, 'api_error', null, 'down'));
      if (stripe === '404') return Promise.reject(new StripeApiError(404, 'invalid_request_error', 'resource_missing', 'gone'));
      return Promise.resolve({ id: 'sub_1', status: 'canceled' });
    },
  };
  const handle = createDeleteHandler({
    getUser: () => Promise.resolve({ id: 'user-1' }),
    subscriptionFor: () => Promise.resolve(sub),
    stripe: stripe === 'none' ? undefined : client,
    deleteUser: (id) => { deleted.push(id); return Promise.resolve(); },
  });
  const run = async () => {
    const res = await handle(new Request('https://x/f', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) }));
    return { status: res.status, body: await res.json() };
  };
  return { run, dels, deleted };
}

Deno.test('active subscription: cancelled at Stripe first, then the account is deleted', async () => {
  const t = setup({ status: 'active', stripe_subscription_id: 'sub_1' });
  assertEq((await t.run()).status, 200, 'status');
  assertEq(t.dels, ['/subscriptions/sub_1'], 'cancelled at Stripe');
  assertEq(t.deleted, ['user-1'], 'deleted');
});

Deno.test('if Stripe cannot cancel, the account is NOT deleted', async () => {
  const t = setup({ status: 'past_due', stripe_subscription_id: 'sub_1' }, 'fail');
  const r = await t.run();
  assertEq([r.status, r.body.error.code], [502, 'subscription_cancel_failed'], 'refused');
  assertEq(t.deleted, [], 'not deleted');
});

Deno.test('subscription already gone at Stripe: deletion proceeds', async () => {
  const t = setup({ status: 'active', stripe_subscription_id: 'sub_1' }, '404');
  assertEq((await t.run()).status, 200, 'status');
  assertEq(t.deleted, ['user-1'], 'deleted');
});

Deno.test('Stripe not configured but a billable subscription exists: refused, not deleted', async () => {
  const t = setup({ status: 'active', stripe_subscription_id: 'sub_1' }, 'none');
  assertEq((await t.run()).body.error.code, 'active_subscription', 'refused');
  assertEq(t.deleted, [], 'not deleted');
});

Deno.test('free or cancelled accounts are deleted without calling Stripe', async () => {
  for (const sub of [null, { status: 'active', stripe_subscription_id: null }, { status: 'canceled', stripe_subscription_id: 'sub_1' }]) {
    const t = setup(sub);
    assertEq((await t.run()).status, 200, JSON.stringify(sub));
    assertEq(t.dels, [], 'no Stripe call');
  }
});

Deno.test('still requires the explicit confirmation', async () => {
  const handle = createDeleteHandler({
    getUser: () => Promise.resolve({ id: 'user-1' }), subscriptionFor: () => Promise.resolve(null), stripe: undefined,
    deleteUser: () => { throw new Error('must not delete'); },
  });
  const res = await handle(new Request('https://x/f', { method: 'POST', body: '{}' }));
  assertEq(res.status, 400, 'confirmation required');
});
