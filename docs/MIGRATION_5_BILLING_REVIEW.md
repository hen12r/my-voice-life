# Review: migration 5 (Stripe billing)

**Status:** for your review only. **Not applied.** The live database is unchanged.

**Live state, checked read-only on 2026-11-20:**
- `subscriptions` has the checks `subscriptions_billing_interval_check`, `subscriptions_plan_check` and `subscriptions_status_check`;
- 2 rows, both `free` / `active`, with no Stripe customer;
- the `mvl_stripe_events` table doesn't exist.

## Purpose
Lets the verified Stripe webhook keep each user's existing `subscriptions` row in sync. Who gets Premium is decided exactly as before, by `effective_plan()`, which this migration does **not** change.

## Every change
| What | Change | Who can use it |
|---|---|---|
| `subscriptions.status` check | drops `subscriptions_status_check` (from migration 1; confirmed live) and adds `mvl_subscriptions_status_chk`, which also allows Stripe's `unpaid`, `incomplete`, `incomplete_expired`, `paused`. None of these give Premium. | n/a |
| `subscriptions` columns | **adds** `cancel_at_period_end` (default false), `stripe_price_id`, `stripe_livemode`, `stripe_synced_at`; **adds** a format check on Stripe ids (`cus_…`, `sub_…`, `price_…`) | owner can **read** own row (existing RLS); **no client writes** (unchanged) |
| Table `mvl_stripe_events` | **new**: webhook idempotency ledger. It holds event id, type, time, mode, user id and outcome only: no personal or card data. RLS on, with every right revoked from `anon` and `authenticated`. | service role only |
| Function `mvl_billing_link_customer(user, customer)` | **new**, SECURITY DEFINER: binds a Stripe customer to one user, once. Refuses a second user or a different customer. | **service role only** |
| Function `mvl_billing_apply_subscription(…)` | **new**, SECURITY DEFINER: idempotent per event id. Finds the user from the customer **we** linked (metadata is only a cross-check), never moves a subscription between users, and ignores late events about an old subscription. | **service role only** |

- **Not touched:** `effective_plan()`, plan limits, budgets, AI controls, notes, tasks, profiles, RLS policies.
- **Data changed:** none. The 2 existing rows keep their values; the new columns take their defaults.
- **Data deleted:** none.

## Tests
- **Automated:** `supabase/tests/billing_test.sql`, part of `npm run test:db`, which CI runs on every push. Every elevated function is checked for permission denied (SQLSTATE 42501) for users and visitors.
- **Rollback:** [`supabase/rollback/rollback_20261120_migration_5_billing.sql`](../supabase/rollback/rollback_20261120_migration_5_billing.sql). It refuses once any Stripe customer, subscription or event exists. Tested: the refusal, a clean rollback, and re-applying afterwards.
- **First response to a problem:** remove `STRIPE_SECRET_KEY` from the Supabase secrets, or disable the webhook endpoint in Stripe. Both stop all billing activity without touching the database.

## If you approve ("Approve migration 5")
1. Read-only pre-check that the live state above is unchanged.
2. Apply the file verbatim as version `20261120000001`.
3. Read-only verification: columns, constraint, ledger table, function rights, the 2 rows unchanged, the security advisor.
4. Report back.

Nothing is deployed and no secret is added as part of this step.

---

## Appendix: exact migration text (verbatim from the branch)
```sql
-- =====================================================================
-- My Voice Life — Stripe subscription billing (additive)
-- ---------------------------------------------------------------------
-- The `subscriptions` table (migration 1) already holds plan, status, period end and the Stripe
-- ids, and effective_plan() already grants Premium only while status is active/trialing AND
-- the period has not ended. This migration lets verified Stripe webhooks keep that row in sync:
--   * accepts every Stripe subscription status (so nothing is coerced into a wrong one);
--   * records which Stripe price/mode a subscription uses and whether it cancels at period end;
--   * an idempotency ledger of processed webhook events (no personal data, no card data);
--   * two SECURITY DEFINER functions, executable by the service role ONLY (Edge Functions):
--       mvl_billing_link_customer   — binds a Stripe customer to exactly one user, once;
--       mvl_billing_apply_subscription — applies a subscription snapshot fetched from Stripe.
-- Browsers can still only READ their own subscription row (owner-only RLS, unchanged).
-- Nothing here changes effective_plan(), plan limits, budgets or any existing row.
-- =====================================================================

do $$ begin
  if to_regclass('public.subscriptions') is null or to_regprocedure('public.effective_plan(uuid)') is null then
    raise exception 'MVL pre-flight: apply 20261118000001_my_voice_life_core.sql first.';
  end if;
end $$;

-- 1. Every Stripe subscription status. Only active/trialing (within the period) give Premium,
--    exactly as before: past_due, unpaid, incomplete, incomplete_expired, paused and canceled don't.
alter table public.subscriptions drop constraint if exists subscriptions_status_check;
do $$ begin
  alter table public.subscriptions add constraint mvl_subscriptions_status_chk check (status in
    ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'));
exception when duplicate_object then null; end $$;

alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.subscriptions add column if not exists stripe_price_id text;
alter table public.subscriptions add column if not exists stripe_livemode boolean;
alter table public.subscriptions add column if not exists stripe_synced_at timestamptz;
do $$ begin
  alter table public.subscriptions add constraint mvl_subscriptions_stripe_ids_chk check (
        (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$')
    and (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
    and (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$'));
exception when duplicate_object then null; end $$;

-- 2. Idempotency ledger: each Stripe event is applied at most once (Stripe may deliver an event
--    more than once, and out of order). Only ids, types and outcomes are kept.
create table if not exists public.mvl_stripe_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'),
  event_type text not null check (char_length(event_type) <= 100),
  stripe_created timestamptz not null,
  livemode boolean not null,
  user_id uuid references auth.users (id) on delete set null,
  outcome text not null check (outcome in ('applied', 'ignored_other_subscription', 'unlinked', 'user_mismatch')),
  received_at timestamptz not null default now()
);
create index if not exists mvl_stripe_events_user_idx on public.mvl_stripe_events (user_id);
alter table public.mvl_stripe_events enable row level security;
revoke all on public.mvl_stripe_events from anon, authenticated;

-- 3. Bind a Stripe customer to a user. Called by the billing Edge Function right after it creates
--    the customer for the signed-in user. A user keeps one customer; a customer belongs to one user.
create or replace function public.mvl_billing_link_customer(p_user uuid, p_customer text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_existing text; v_owner uuid;
begin
  if p_user is null or p_customer is null or p_customer !~ '^cus_[A-Za-z0-9]+$' then
    raise exception 'invalid customer link';
  end if;
  select user_id into v_owner from public.subscriptions where stripe_customer_id = p_customer;
  if v_owner is not null and v_owner <> p_user then
    raise exception 'customer already linked to another user';
  end if;
  insert into public.subscriptions (user_id) values (p_user) on conflict (user_id) do nothing;
  select stripe_customer_id into v_existing from public.subscriptions where user_id = p_user for update;
  if v_existing is not null and v_existing <> p_customer then
    raise exception 'user already has a different customer';
  end if;
  update public.subscriptions set stripe_customer_id = p_customer where user_id = p_user;
end;
$$;

-- 4. Apply a subscription snapshot. The Edge Function calls this ONLY after it has verified the
--    webhook signature AND re-fetched the subscription from Stripe's API (the event payload itself
--    is not trusted). The user is found from the customer id that WE linked; the metadata user id
--    is only a cross-check. Runs in one transaction with the idempotency insert, so a failure
--    leaves no trace and Stripe's retry is processed normally.
create or replace function public.mvl_billing_apply_subscription(
  p_event_id text, p_event_type text, p_event_created timestamptz, p_livemode boolean,
  p_customer text, p_subscription text, p_status text, p_price_id text, p_interval text,
  p_period_end timestamptz, p_cancel_at_period_end boolean, p_metadata_user uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  s public.subscriptions;
  v_outcome text;
  v_plan text;
begin
  if p_status not in ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused') then
    raise exception 'unknown subscription status %', p_status;
  end if;
  if p_interval is not null and p_interval not in ('month', 'year') then
    raise exception 'unsupported billing interval %', p_interval;
  end if;

  -- Idempotency: a repeated event changes nothing.
  insert into public.mvl_stripe_events (event_id, event_type, stripe_created, livemode, outcome)
  values (p_event_id, p_event_type, p_event_created, p_livemode, 'applied')
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select user_id into v_user from public.subscriptions where stripe_customer_id = p_customer;

  if v_user is null then
    v_outcome := 'unlinked';                  -- a customer we never created for anyone
  elsif p_metadata_user is not null and p_metadata_user <> v_user then
    v_outcome := 'user_mismatch';             -- never move a subscription between users
  else
    select * into s from public.subscriptions where user_id = v_user for update;
    -- An event about an OLD subscription must not overwrite a different, current one.
    if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription
       and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')
       and p_status in ('canceled', 'incomplete_expired', 'incomplete') then
      v_outcome := 'ignored_other_subscription';
    else
      v_outcome := 'applied';
      v_plan := case when p_status in ('canceled', 'incomplete_expired') then 'free' else 'premium' end;
      update public.subscriptions set
        plan = v_plan,
        status = p_status,
        billing_interval = p_interval,
        current_period_end = p_period_end,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
        stripe_subscription_id = p_subscription,
        stripe_price_id = p_price_id,
        stripe_livemode = p_livemode,
        stripe_synced_at = now()
      where user_id = v_user;
    end if;
  end if;

  update public.mvl_stripe_events set outcome = v_outcome, user_id = v_user where event_id = p_event_id;
  return jsonb_build_object('outcome', v_outcome, 'user_id', v_user, 'plan', v_plan, 'status', p_status);
end;
$$;

-- 5. Execution rights: service role (Edge Functions) only.
revoke execute on function public.mvl_billing_link_customer(uuid, text) from public, anon, authenticated;
revoke execute on function public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.mvl_billing_link_customer(uuid, text) to service_role;
grant execute on function public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid) to service_role;
```
