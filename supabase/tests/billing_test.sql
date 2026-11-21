-- Stripe billing tests (migrations 20261120000001 + 20261122000001: plans free/plus/pro). Run after all migrations (scripts/test-db.sh).
-- Simulates what the stripe-webhook Edge Function does AFTER verifying a signature and
-- re-fetching the subscription from Stripe: calls the service-role-only RPCs.
\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin if coalesce(cond, false) then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when insufficient_privilege then raise notice 'PASS  %', label; return;
            when others then raise exception 'FAIL  % (failed for the wrong reason: % %)', label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL  % (statement succeeded but should have been denied)', label;
end $$;
create or replace function pg_temp.expect_error(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS  %', label; return; end;
  raise exception 'FAIL  % (statement succeeded but should have failed)', label;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;
-- One webhook application, as the Edge Function makes it (service role).
create or replace function pg_temp.apply(evt text, cus text, sub text, status text, period_end timestamptz,
  cancel_at_end boolean default false, meta uuid default null, interval_ text default 'month', plan_ text default 'plus') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  r := public.mvl_billing_apply_subscription_v2(evt, 'customer.subscription.updated', now(), false, cus, sub, status,
         'price_TestMonthly', interval_, period_end, cancel_at_end, meta, plan_);
  reset role;
  return r;
end $$;
create or replace function pg_temp.sub(uid uuid) returns public.subscriptions language sql as $$
  select * from public.subscriptions where user_id = uid $$;

insert into auth.users (id, email) values
  ('b1000000-0000-0000-0000-000000000001', 'payer@test'),
  ('b1000000-0000-0000-0000-000000000002', 'other@test'),
  ('b1000000-0000-0000-0000-000000000003', 'attacker@test');

-- ===================== Permissions =====================
select pg_temp.expect(not has_function_privilege('authenticated', 'public.mvl_billing_apply_subscription_v2(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid,text)', 'execute'), 'apply_subscription_v2: authenticated has no EXECUTE');
select pg_temp.expect(not has_function_privilege('anon', 'public.mvl_billing_apply_subscription_v2(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid,text)', 'execute'), 'apply_subscription_v2: anon has no EXECUTE');
select pg_temp.expect(has_function_privilege('service_role', 'public.mvl_billing_apply_subscription_v2(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid,text)', 'execute'), 'apply_subscription_v2: service_role has EXECUTE');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.mvl_billing_link_customer(uuid,text)', 'execute'), 'link_customer: authenticated has no EXECUTE');
select pg_temp.expect(not has_function_privilege('anon', 'public.mvl_billing_link_customer(uuid,text)', 'execute'), 'link_customer: anon has no EXECUTE');

select pg_temp.as_user('b1000000-0000-0000-0000-000000000003');
select pg_temp.expect_denied($$select public.mvl_billing_apply_subscription_v2('evt_Fake1','customer.subscription.updated',now(),false,'cus_X','sub_X','active','price_X','month',now()+interval '30 days',false,null,'pro')$$,
  'a signed-in user cannot grant themselves Pro through the RPC');
select pg_temp.expect_denied($$select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000003','cus_Stolen')$$, 'a signed-in user cannot link a customer');
select pg_temp.expect_denied($$update public.subscriptions set plan = 'pro', status = 'active'$$, 'a signed-in user cannot update their subscription row');
select pg_temp.expect_denied($$select * from public.mvl_stripe_events$$, 'a signed-in user cannot read the webhook ledger');
select pg_temp.expect((select count(*) = 1 from public.subscriptions), 'a user sees only their own subscription row');
reset role;
select set_config('request.jwt.claims', '', false);

-- ===================== Linking =====================
set role service_role;
select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000001', 'cus_Payer1');
select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000001', 'cus_Payer1'); -- idempotent
reset role;
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).stripe_customer_id = 'cus_Payer1', 'customer linked to the user who started checkout');
set role service_role;
select pg_temp.expect_error($$select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000002','cus_Payer1')$$, 'a customer cannot be linked to a second user');
select pg_temp.expect_error($$select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000001','cus_Another')$$, 'a user cannot be re-linked to a different customer');
select pg_temp.expect_error($$select public.mvl_billing_link_customer('b1000000-0000-0000-0000-000000000002','not-a-customer')$$, 'malformed customer id rejected');
reset role;

-- ===================== Successful payment =====================
select pg_temp.expect((pg_temp.apply('evt_Paid1', 'cus_Payer1', 'sub_Payer1', 'active', now() + interval '30 days'))->>'outcome' = 'applied', 'successful checkout: snapshot applied');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'successful payment: user is on Plus');
select pg_temp.expect((select captures_limit = 300 from (select (l.ai_captures_per_month) as captures_limit from public.mvl_plan_limits l where l.plan = public.effective_plan('b1000000-0000-0000-0000-000000000001')) x), 'Plus limits now apply, from the plan-limits table');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000002') = 'free', 'other users are unaffected');

-- Idempotency: the same event again changes nothing.
update public.subscriptions set status = 'active' where user_id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.expect((pg_temp.apply('evt_Paid1', 'cus_Payer1', 'sub_Payer1', 'canceled', now()))->>'outcome' = 'duplicate', 'replayed event is recognised as a duplicate');
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).status = 'active', 'replayed event changed nothing');

-- ===================== Renewal =====================
select pg_temp.apply('evt_Renew1', 'cus_Payer1', 'sub_Payer1', 'active', now() + interval '61 days');
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).current_period_end > now() + interval '60 days', 'renewal extends the period end');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'renewal keeps Plus');

-- ===================== Failed payment =====================
select pg_temp.apply('evt_Fail1', 'cus_Payer1', 'sub_Payer1', 'past_due', now() + interval '61 days');
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).status = 'past_due', 'failed payment: status past_due');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'failed payment within the period: Plus kept while Stripe retries');
update public.subscriptions set current_period_end = now() - interval '3 days' where user_id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'failed payment, 3 days after period end: still inside the 7-day grace');
update public.subscriptions set current_period_end = now() - interval '8 days' where user_id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'failed payment, grace (7 days) over: back to free limits');
update public.mvl_app_settings set billing_grace_days = 0;
update public.subscriptions set current_period_end = now() - interval '1 minute' where user_id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'grace period is configurable (0 days = no grace)');
update public.mvl_app_settings set billing_grace_days = 7;
select pg_temp.apply('evt_Recover1', 'cus_Payer1', 'sub_Payer1', 'active', now() + interval '61 days');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'payment recovered: Plus restored');
select pg_temp.apply('evt_Unpaid1', 'cus_Payer1', 'sub_Payer1', 'unpaid', now() + interval '61 days');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'retries exhausted (unpaid): back to free');
select pg_temp.apply('evt_Recover2', 'cus_Payer1', 'sub_Payer1', 'active', now() + interval '61 days');

-- ===================== Cancellation =====================
select pg_temp.apply('evt_CancelEnd1', 'cus_Payer1', 'sub_Payer1', 'active', now() + interval '61 days', true);
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).cancel_at_period_end, 'cancel at period end is recorded');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'cancelled at period end: Plus until the period ends');
select pg_temp.apply('evt_Deleted1', 'cus_Payer1', 'sub_Payer1', 'canceled', now());
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).plan = 'free', 'subscription deleted: plan back to free');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'subscription deleted: back to free');
select pg_temp.expect((pg_temp.sub('b1000000-0000-0000-0000-000000000001')).stripe_customer_id = 'cus_Payer1', 'customer link kept after cancellation (for re-subscribing and the portal)');

-- ===================== Expiry without any webhook =====================
select pg_temp.apply('evt_Resub1', 'cus_Payer1', 'sub_Payer2', 'active', now() - interval '1 minute');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'period ended and no renewal confirmed: the paid plan expires on its own');
select pg_temp.apply('evt_Resub2', 'cus_Payer1', 'sub_Payer2', 'active', now() + interval '30 days');
select pg_temp.apply('evt_IncompleteExp', 'cus_Payer1', 'sub_Payer2', 'incomplete_expired', null);
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'free', 'incomplete_expired: free');
select pg_temp.apply('evt_Resub3', 'cus_Payer1', 'sub_Payer2', 'active', now() + interval '30 days');

-- ===================== Upgrade and downgrade (plan derived server-side from the price) =====================
select pg_temp.expect((pg_temp.apply('evt_Upgrade1', 'cus_Payer1', 'sub_Payer2', 'active', now() + interval '30 days', false, null, 'month', 'pro'))->>'outcome' = 'applied', 'upgrade event applied');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'pro', 'upgrade: user is on Pro');
select pg_temp.expect((select byoai_captures_per_day = 200 from public.mvl_plan_limits where plan = public.effective_plan('b1000000-0000-0000-0000-000000000001')), 'Pro limits apply after the upgrade');
select pg_temp.apply('evt_Downgrade1', 'cus_Payer1', 'sub_Payer2', 'active', now() + interval '30 days', false, null, 'month', 'plus');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'downgrade: user is back on Plus');
set role service_role;
select pg_temp.expect_error($$select public.mvl_billing_apply_subscription_v2('evt_NoPlan','x',now(),false,'cus_Payer1','sub_Payer2','active','price_X','month',now()+interval '1 day',false,null,null)$$, 'a paid status without a plan is rejected');
select pg_temp.expect_error($$select public.mvl_billing_apply_subscription_v2('evt_BadPlan','x',now(),false,'cus_Payer1','sub_Payer2','active','price_X','month',now()+interval '1 day',false,null,'premium')$$, 'the retired premium plan is rejected');
reset role;
select pg_temp.expect(to_regprocedure('public.mvl_billing_apply_subscription(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid)') is null, 'v1 (always premium) no longer exists');

-- ===================== Out-of-order and cross-user safety =====================
-- A late "canceled" event about the OLD subscription must not cancel the current one.
select pg_temp.expect((pg_temp.apply('evt_LateOld', 'cus_Payer1', 'sub_Payer1', 'canceled', now()))->>'outcome' = 'ignored_other_subscription', 'late event about an old subscription is ignored');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'current subscription unaffected by the late old event');
-- Metadata claiming another user is refused: subscriptions never move between users.
select pg_temp.expect((pg_temp.apply('evt_Mismatch', 'cus_Payer1', 'sub_Payer2', 'canceled', now(), false, 'b1000000-0000-0000-0000-000000000003'))->>'outcome' = 'user_mismatch', 'metadata naming a different user is refused');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000001') = 'plus', 'refused mismatch changed nothing');
-- A customer we never linked to anyone gives nobody Premium.
select pg_temp.expect((pg_temp.apply('evt_Unknown', 'cus_Unknown', 'sub_Unknown', 'active', now() + interval '30 days', false, 'b1000000-0000-0000-0000-000000000003'))->>'outcome' = 'unlinked', 'unknown customer: unlinked, nothing granted');
select pg_temp.expect(public.effective_plan('b1000000-0000-0000-0000-000000000003') = 'free', 'metadata alone can never grant a paid plan');
-- Bad input.
set role service_role;
select pg_temp.expect_error($$select public.mvl_billing_apply_subscription_v2('evt_Bad1','x',now(),false,'cus_Payer1','sub_Payer2','superactive','price_X','month',now(),false,null,'plus')$$, 'unknown status rejected');
select pg_temp.expect_error($$select public.mvl_billing_apply_subscription_v2('evt_Bad2','x',now(),false,'cus_Payer1','sub_Payer2','active','price_X','week',now(),false,null,'plus')$$, 'unsupported interval rejected');
select pg_temp.expect_error($$select public.mvl_billing_apply_subscription_v2('not-an-event','x',now(),false,'cus_Payer1','sub_Payer2','active','price_X','month',now(),false,null,'plus')$$, 'malformed event id rejected');
reset role;
select pg_temp.expect((select count(*) = 0 from public.mvl_stripe_events where event_id in ('evt_Bad1', 'evt_Bad2', 'evt_NoPlan', 'evt_BadPlan')), 'rejected events leave no ledger entry (Stripe can retry)');
select pg_temp.expect((select outcome from public.mvl_stripe_events where event_id = 'evt_Mismatch') = 'user_mismatch', 'ledger records the outcome for audit');

-- ===================== Account deletion =====================
delete from auth.users where id = 'b1000000-0000-0000-0000-000000000001';
select pg_temp.expect((select count(*) = 0 from public.subscriptions where user_id = 'b1000000-0000-0000-0000-000000000001'), 'deleting the account removes its subscription row');
select pg_temp.expect((select count(*) > 0 from public.mvl_stripe_events where user_id is null and event_id = 'evt_Paid1'), 'ledger keeps anonymised event ids after account deletion');

\echo 'ALL BILLING TESTS PASSED'
