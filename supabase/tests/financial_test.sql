-- Financial controls tests. Run after all migrations (scripts/test-db.sh).
\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin if coalesce(cond, false) then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;
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
-- Accounting calls exactly as the Edge Function makes them (service role).
create or replace function pg_temp.res(uid uuid, src text, secs numeric, model text default 'gemini-2.5-flash') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture(uid, src, secs, 'gemini', model);
  execute 'reset role';
  return r;
end $$;
create or replace function pg_temp.rec(id uuid, a int, t int, o int, th int) returns numeric language plpgsql as $$
declare c numeric;
begin execute 'set role service_role'; c := public.mvl_record_ai_call(id, a, t, o, th); execute 'reset role'; return c; end $$;
create or replace function pg_temp.fin(id uuid, st text) returns void language plpgsql as $$
begin execute 'set role service_role'; perform public.mvl_finish_ai_capture(id, st, null); execute 'reset role'; end $$;
-- Reserve + finish OK in one go; returns the reservation result.
create or replace function pg_temp.capture(uid uuid, src text, secs numeric) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.res(uid, src, secs);
  if (r->>'ok')::boolean then perform pg_temp.fin((r->>'reservation_id')::uuid, 'ok'); end if;
  return r;
end $$;

-- Users: F free, X free, Y free, P plus (monthly), Q pro (monthly), A admin, T tester
insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-000000000001', 'f@test'), ('a0000000-0000-0000-0000-000000000007', 'x@test'),
  ('b0000000-0000-0000-0000-000000000008', 'y@test'), ('c0000000-0000-0000-0000-000000000003', 'p@test'),
  ('d0000000-0000-0000-0000-000000000004', 'q@test'), ('e0000000-0000-0000-0000-000000000005', 'admin@test'),
  ('e0000000-0000-0000-0000-000000000006', 'tester@test');
update public.subscriptions set plan = 'plus', billing_interval = 'month' where user_id = 'c0000000-0000-0000-0000-000000000003';
update public.subscriptions set plan = 'pro', billing_interval = 'month' where user_id = 'd0000000-0000-0000-0000-000000000004';
insert into public.mvl_staff values ('e0000000-0000-0000-0000-000000000005', 'admin'), ('e0000000-0000-0000-0000-000000000006', 'tester');

-- ===================== Access control =====================
select pg_temp.as_user('f0000000-0000-0000-0000-000000000001');
select pg_temp.expect_error('select * from public.mvl_app_settings', 'user cannot read settings');
select pg_temp.expect_error('select * from public.mvl_staff', 'user cannot read staff list');
select pg_temp.expect_error('select * from public.mvl_price_book', 'user cannot read price book');
select pg_temp.expect_error('select * from public.mvl_operating_expenses', 'user cannot read expenses');
select pg_temp.expect_error('select * from public.mvl_budget_alerts', 'user cannot read alerts');
select pg_temp.expect_error('select * from public.mvl_daily_activity', 'user cannot read activity table');
select pg_temp.expect_error($$insert into public.mvl_ai_usage (user_id, plan, source, status) values ('f0000000-0000-0000-0000-000000000001','free','text','ok')$$, 'user cannot insert usage rows');
select pg_temp.expect_error($$update public.mvl_plan_limits set ai_captures_per_month = 999$$, 'user cannot change plan limits');
select pg_temp.expect_error($$update public.mvl_app_settings set ai_mode = 'on'$$, 'user cannot flip the kill switch');
select pg_temp.expect_error($$select public.mvl_reserve_ai_capture('f0000000-0000-0000-0000-000000000001','text',0,'gemini','gemini-2.5-flash')$$, 'user cannot call reserve directly');
select pg_temp.expect_error($$select public.mvl_finish_ai_capture(gen_random_uuid(),'ok',null)$$, 'user cannot call finish directly');
select pg_temp.expect_error($$select public.mvl_admin_usage_summary(null)$$, 'non-admin cannot read usage dashboard');
select pg_temp.expect_error($$select public.mvl_admin_finance_summary(null)$$, 'non-admin cannot read finance dashboard');
select pg_temp.expect_error($$select public.mvl_admin_update_settings(p_ai_mode => 'on')$$, 'non-admin cannot change settings');
select pg_temp.expect((select count(*) = 3 from public.mvl_plan_limits), 'user can read plan limits (free, plus, pro)');
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.expect_error('select public.mvl_my_usage()', 'anon cannot read usage');
reset role;

-- ===================== Test-only mode and kill switch =====================
select pg_temp.expect((select ai_mode = 'admins_only' from public.mvl_app_settings), 'AI starts in admins_only mode');
select pg_temp.expect(pg_temp.res('f0000000-0000-0000-0000-000000000001', 'text', 0)->>'reason' = 'ai_test_mode', 'admins_only: regular user refused');
select pg_temp.expect((pg_temp.capture('e0000000-0000-0000-0000-000000000006', 'text', 0)->>'ok')::boolean, 'admins_only: tester allowed');
select pg_temp.expect((pg_temp.capture('e0000000-0000-0000-0000-000000000005', 'text', 0)->>'ok')::boolean, 'admins_only: admin allowed');
update public.mvl_app_settings set ai_mode = 'off';
select pg_temp.expect(pg_temp.res('e0000000-0000-0000-0000-000000000005', 'text', 0)->>'reason' = 'ai_paused', 'kill switch off: even admin refused');
update public.mvl_app_settings set ai_mode = 'on';
select pg_temp.expect(pg_temp.res('f0000000-0000-0000-0000-000000000001', 'text', 0, 'unknown-model')->>'reason' = 'ai_price_unknown', 'unknown model refused (fail closed)');

-- ===================== Free plan: 7 AI captures =====================
update public.mvl_plan_limits set captures_per_hour = 100, captures_per_day = 100 where plan = 'free';  -- isolate the monthly rule
do $$ begin for i in 1..7 loop perform pg_temp.capture('f0000000-0000-0000-0000-000000000001', 'text', 0); end loop; end $$;
select pg_temp.expect(pg_temp.res('f0000000-0000-0000-0000-000000000001', 'text', 0)->>'reason' = 'quota_captures', 'free: 8th AI capture refused');
select pg_temp.as_user('f0000000-0000-0000-0000-000000000001');
select pg_temp.expect((public.mvl_my_usage()->>'captures_used')::int = 7 and (public.mvl_my_usage()->>'captures_limit')::int = 7, 'my_usage shows 7 / 7');
select pg_temp.expect((select count(*) > 0 and count(*) = count(*) filter (where user_id = 'f0000000-0000-0000-0000-000000000001') from public.mvl_ai_usage), 'user sees only own usage rows');
-- Users cannot reset the allowance by deleting anything.
delete from public.voice_sessions;
select pg_temp.expect_error('delete from public.mvl_ai_usage', 'user cannot delete usage rows');
select pg_temp.expect_error($$update public.mvl_ai_usage set status = 'failed'$$, 'user cannot alter usage rows');
reset role;
select pg_temp.expect(pg_temp.res('f0000000-0000-0000-0000-000000000001', 'text', 0)->>'reason' = 'quota_captures', 'deleting notes/sessions does not restore the allowance');
select pg_temp.as_user('f0000000-0000-0000-0000-000000000001');
insert into public.notes (body) values ('manual note after AI limit');
select pg_temp.expect((select count(*) = 1 from public.notes), 'manual notes still work at the AI limit');
reset role;

-- Failed captures do not use the monthly allowance (but count for rate limits)
do $$ declare r jsonb; begin
  r := pg_temp.res('a0000000-0000-0000-0000-000000000007', 'text', 0);
  perform pg_temp.fin((r->>'reservation_id')::uuid, 'failed');
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000007');
select pg_temp.expect((public.mvl_my_usage()->>'captures_used')::int = 0, 'failed capture does not use allowance');
reset role;
select pg_temp.expect(pg_temp.res('a0000000-0000-0000-0000-000000000007', 'voice', 200)->>'reason' = 'audio_too_long', 'free: recording over 2 min refused');

-- ===================== Rate limits =====================
update public.mvl_plan_limits set captures_per_hour = 5, captures_per_day = 7 where plan = 'free';
do $$ begin for i in 1..5 loop perform pg_temp.capture('b0000000-0000-0000-0000-000000000008', 'text', 0); end loop; end $$;
select pg_temp.expect(pg_temp.res('b0000000-0000-0000-0000-000000000008', 'text', 0)->>'reason' = 'rate_limited_hour', 'free: 6th capture in an hour refused');
update public.mvl_plan_limits set captures_per_hour = 100, captures_per_day = 6 where plan = 'free';
select pg_temp.expect((pg_temp.capture('b0000000-0000-0000-0000-000000000008', 'text', 0)->>'ok')::boolean, 'per-day allowance: 6th of the day allowed');
select pg_temp.expect(pg_temp.res('b0000000-0000-0000-0000-000000000008', 'text', 0)->>'reason' = 'rate_limited_day', 'free: 7th capture in a day refused by daily limit');
update public.mvl_plan_limits set captures_per_hour = 5, captures_per_day = 7 where plan = 'free';

-- ===================== Premium: captures and minutes enforced independently =====================
update public.mvl_plan_limits set audio_minutes_per_month = 10 where plan = 'plus';
select pg_temp.expect((pg_temp.capture('c0000000-0000-0000-0000-000000000003', 'voice', 240)->>'ok')::boolean, 'plus: 4 min capture ok');
select pg_temp.expect((pg_temp.capture('c0000000-0000-0000-0000-000000000003', 'voice', 240)->>'ok')::boolean, 'plus: second 4 min capture ok (8/10 min)');
select pg_temp.expect(pg_temp.res('c0000000-0000-0000-0000-000000000003', 'voice', 240)->>'reason' = 'quota_minutes', 'plus: minutes limit refuses with only 2 captures used');
select pg_temp.expect((pg_temp.capture('c0000000-0000-0000-0000-000000000003', 'voice', 90)->>'ok')::boolean, 'plus: a short capture that fits the remaining minutes is allowed');
update public.mvl_plan_limits set audio_minutes_per_month = 600, ai_captures_per_month = 3 where plan = 'plus';
select pg_temp.expect(pg_temp.res('c0000000-0000-0000-0000-000000000003', 'text', 0)->>'reason' = 'quota_captures', 'plus: captures limit refuses while minutes remain');
update public.mvl_plan_limits set ai_captures_per_month = 300 where plan = 'plus';
select pg_temp.expect(pg_temp.res('c0000000-0000-0000-0000-000000000003', 'voice', 400)->>'reason' = 'audio_too_long', 'plus: recording over 5 min refused');

-- ===================== Cost recording =====================
do $$ declare r jsonb; c numeric; u public.mvl_ai_usage; begin
  r := pg_temp.res('d0000000-0000-0000-0000-000000000004', 'voice', 45);
  -- transcription: 30 s of audio (960 tokens) + 50 prompt tokens in, 150 out
  c := pg_temp.rec((r->>'reservation_id')::uuid, 960, 50, 150, 0);
  -- extraction: 700 text in, 300 out, 20 thinking
  c := pg_temp.rec((r->>'reservation_id')::uuid, 0, 700, 300, 20);
  perform pg_temp.fin((r->>'reservation_id')::uuid, 'ok');
  select * into u from public.mvl_ai_usage where id = (r->>'reservation_id')::uuid;
  -- 960*1.00 + 750*0.30 + 470*2.50 = 960 + 225 + 1175 = 2360 per 1M = 0.002360
  perform pg_temp.expect(u.est_cost_usd = 0.002360, 'cost = recorded tokens x price book ($0.002360)');
  perform pg_temp.expect(u.audio_seconds = 30, 'actual audio length (30 s) replaces the 45 s estimate');
  perform pg_temp.expect(u.provider_calls = 2 and u.thinking_tokens = 20, 'calls and thinking tokens recorded');
  perform pg_temp.expect_error(format('select pg_temp.fin(%L, %L)', r->>'reservation_id', 'ok'), 'a capture cannot be finished twice');
  perform pg_temp.expect_error(format('select pg_temp.rec(%L, 1, 1, 1, 0)', r->>'reservation_id'), 'no usage can be added after finishing');
end $$;
select pg_temp.expect_error($$select pg_temp.rec(gen_random_uuid(), -5, 0, 0, 0)$$, 'negative token counts rejected');

-- ===================== Abandoned reservations expire conservatively =====================
do $$ declare r jsonb; u public.mvl_ai_usage; begin
  r := pg_temp.res('d0000000-0000-0000-0000-000000000004', 'text', 0);
  update public.mvl_ai_usage set occurred_at = now() - interval '20 minutes' where id = (r->>'reservation_id')::uuid;
  perform pg_temp.capture('d0000000-0000-0000-0000-000000000004', 'text', 0);   -- next reservation triggers expiry
  select * into u from public.mvl_ai_usage where id = (r->>'reservation_id')::uuid;
  perform pg_temp.expect(u.status = 'expired' and u.est_cost_usd = u.reserved_cost_usd and u.est_cost_usd > 0,
    'stale reservation expired and keeps its worst-case cost');
end $$;

-- ===================== Budgets: hard stop, never exceeded =====================
select pg_temp.as_user('c0000000-0000-0000-0000-000000000003');
insert into public.notes (body) values ('premium note before budget stop');
reset role;
do $$ declare spend numeric; r jsonb; n int := 0; begin
  spend := public.mvl_spend_since(date_trunc('day', now()));
  -- Text capture ceiling with defaults: 6500*0.30 + 2*2048*2.50 = 12190 per 1M = $0.01219
  update public.mvl_app_settings set daily_ai_budget_usd = round(spend + 0.05, 2), monthly_ai_budget_usd = 1000;
  loop
    r := pg_temp.res('c0000000-0000-0000-0000-000000000003', 'text', 0);   -- held in flight (not finished)
    exit when not (r->>'ok')::boolean;
    n := n + 1;
    exit when n > 50;
  end loop;
  perform pg_temp.expect(r->>'reason' = 'budget_daily', format('daily budget stops new requests (after %s in flight)', n));
  perform pg_temp.expect(public.mvl_spend_since(date_trunc('day', now())) <= (select daily_ai_budget_usd from public.mvl_app_settings),
    'daily spend incl. in-flight worst case never exceeds the budget');
  perform pg_temp.expect((select count(*) = 1 from public.mvl_budget_alerts where period = 'day' and threshold = 1.0), 'admin alert recorded at 100% of daily budget');
  perform pg_temp.expect((select count(*) = 3 from public.mvl_budget_alerts where period = 'day'), 'one alert per threshold (50/80/100%), no duplicates');
  perform pg_temp.res('c0000000-0000-0000-0000-000000000003', 'text', 0);
  perform pg_temp.expect((select count(*) = 3 from public.mvl_budget_alerts where period = 'day'), 'repeated refusals do not duplicate alerts');
end $$;
do $$ declare spend numeric; r jsonb; begin
  update public.mvl_app_settings set daily_ai_budget_usd = 1000;
  spend := public.mvl_spend_since(date_trunc('month', now()));
  update public.mvl_app_settings set monthly_ai_budget_usd = spend + 0.02;
  r := pg_temp.res('d0000000-0000-0000-0000-000000000004', 'text', 0);
  perform pg_temp.expect((r->>'ok')::boolean, 'monthly budget: request within budget allowed');
  r := pg_temp.res('d0000000-0000-0000-0000-000000000004', 'text', 0);
  perform pg_temp.expect(r->>'reason' = 'budget_monthly', 'monthly budget stops new requests');
  perform pg_temp.expect((r->>'alert_created')::boolean, 'monthly budget refusal reports a new admin alert');
  update public.mvl_app_settings set monthly_ai_budget_usd = 1000;
end $$;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000003');
select pg_temp.expect((select count(*) = 1 from public.notes where body = 'premium note before budget stop'), 'budget stop leaves existing notes intact');
insert into public.notes (body) values ('premium manual note during budget stop');
select pg_temp.expect((select count(*) = 2 from public.notes), 'manual notes can still be created while AI budget is exhausted');
select pg_temp.expect((public.mvl_my_usage()->>'plan') = 'plus', 'my_usage reports plan');
reset role;

-- ===================== Plans cannot be unlimited =====================
select pg_temp.as_user('e0000000-0000-0000-0000-000000000005');
select pg_temp.expect_error($$select public.mvl_admin_update_plan_limits('plus', 0, 600, 300, 30, 60)$$, 'admin cannot set captures to 0/unlimited');
select pg_temp.expect_error($$select public.mvl_admin_update_plan_limits('plus', null, 600, 300, 30, 60)$$, 'admin cannot set captures to NULL (unlimited)');
select pg_temp.expect_error($$select public.mvl_admin_update_settings(p_ai_mode => 'everyone')$$, 'invalid AI mode rejected');
select public.mvl_admin_update_plan_limits('plus', 300, 600, 300, 30, 60);
select pg_temp.expect((select audio_minutes_per_month = 600 from public.mvl_plan_limits where plan = 'plus'), 'admin can change limits without code changes');
select public.mvl_admin_update_settings(p_ai_mode => 'off', p_ai_paused_message => 'Back soon');
select pg_temp.expect((public.mvl_my_usage()->>'ai_available')::boolean = false, 'kill switch via admin RPC takes effect');
select public.mvl_admin_update_settings(p_ai_mode => 'on');
reset role;

-- ===================== Dashboards =====================
select pg_temp.as_user('f0000000-0000-0000-0000-000000000001'); select public.mvl_touch_activity(); select public.mvl_touch_activity(); reset role;
select pg_temp.as_user('c0000000-0000-0000-0000-000000000003'); select public.mvl_touch_activity(); reset role;
select pg_temp.expect((select count(*) = 2 from public.mvl_daily_activity), 'activity marker: one row per user per day');
select pg_temp.as_user('e0000000-0000-0000-0000-000000000005');
select public.mvl_admin_add_expense(current_date, 'Vercel', 'hosting', 20, 'USD', 'estimate', 'Pro plan at launch');
select pg_temp.expect_error($$select public.mvl_admin_add_expense(current_date, 'X', 'hosting', -1, 'USD', 'actual')$$, 'negative expense rejected');
do $$ declare u jsonb; f jsonb; begin
  u := public.mvl_admin_usage_summary(null);
  f := public.mvl_admin_finance_summary(null);
  perform pg_temp.expect((u->'totals'->>'captures_ok')::int > 0, 'usage dashboard aggregates captures');
  perform pg_temp.expect(u::text not like '%manual note%' and f::text not like '%manual note%', 'dashboards contain no note content');
  perform pg_temp.expect(u::text not like '%@test%' and f::text not like '%@test%', 'dashboards contain no emails');
  perform pg_temp.expect(jsonb_array_length(u->'top_users') > 0 and length(u->'top_users'->0->>'user') = 8, 'top users are pseudonymous 8-char hashes');
  perform pg_temp.expect((f->'users'->>'plus')::int = 1 and (f->'users'->>'pro')::int = 1 and (f->'users'->>'paid')::int = 2, 'finance counts plus and pro subscribers');
  perform pg_temp.expect((f->'users'->>'monthly_active')::int = 2, 'finance MAU from activity markers');
  -- Prices are USD (fx 0.90): plus 4.99 → 4.491, pro 9.99 → 8.991; total 13.482 → 13.48
  -- fees (4.491*0.022+0.25) + (8.991*0.022+0.25) = 0.348802 + 0.447802 = 0.7966 → 0.80
  perform pg_temp.expect((f->>'revenue_gross_eur')::numeric = 13.48, 'projected revenue €13.48 (plus + pro, USD converted)');
  perform pg_temp.expect((f->>'stripe_fees_eur')::numeric = 0.80, 'estimated Stripe fees €0.80');
  perform pg_temp.expect((f->>'operating_expenses_eur')::numeric = 18.00, 'USD expenses converted at configured rate');
  perform pg_temp.expect(abs((f->>'estimated_contribution_eur')::numeric
      - ((f->>'revenue_net_eur')::numeric - (f->>'stripe_fees_eur')::numeric - (f->>'ai_costs_eur')::numeric - (f->>'operating_expenses_eur')::numeric)) <= 0.02,
    'contribution = net revenue - fees - AI - expenses');
  perform pg_temp.expect(f->'labels'->>'contribution' like 'ESTIMATE, NOT PROFIT%', 'contribution labelled as estimate, not profit');
  perform pg_temp.expect((f->>'payments_active')::boolean = false and f->'labels'->>'revenue' like 'PROJECTED%', 'revenue labelled as projected (no payments)');
end $$;
reset role;

-- ===================== Tester = voice access only, never admin =====================
-- Stricter than expect_error: the failure must be an authorisation refusal (SQLSTATE 42501),
-- not a typo or a bad argument.
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when insufficient_privilege then raise notice 'PASS  %', label; return;
            when others then raise exception 'FAIL  % (failed for the wrong reason: % %)', label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL  % (statement succeeded but should have been denied)', label;
end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-000000000006');
select pg_temp.expect((public.mvl_my_usage()->>'is_staff')::boolean, 'tester: is_staff true');
select pg_temp.expect(not (public.mvl_my_usage()->>'is_admin')::boolean, 'tester: is_admin false');
select pg_temp.expect(not public.mvl_is_admin(), 'tester: mvl_is_admin() false');
select pg_temp.expect_denied($$select public.mvl_admin_usage_summary(null)$$, 'tester cannot read usage dashboard');
select pg_temp.expect_denied($$select public.mvl_admin_finance_summary(null)$$, 'tester cannot read finance dashboard');
select pg_temp.expect_denied($$select public.mvl_admin_update_settings(p_ai_mode => 'on')$$, 'tester cannot change settings or the kill switch');
select pg_temp.expect_denied($$select public.mvl_admin_update_plan_limits('free', 999, 999, 999, 999, 999)$$, 'tester cannot change plan limits');
select pg_temp.expect_denied($$select public.mvl_admin_add_expense(current_date, 'x', 'x', 1, 'USD', null, null)$$, 'tester cannot add expenses');
select pg_temp.expect_denied($$select public.mvl_admin_delete_expense(1)$$, 'tester cannot delete expenses');
select pg_temp.expect_denied($$select public.mvl_admin_ack_alert(1)$$, 'tester cannot acknowledge budget alerts');
select pg_temp.expect_denied('select * from public.mvl_staff', 'tester cannot read the staff list');
select pg_temp.expect_denied($$update public.mvl_staff set role = 'admin'$$, 'tester cannot promote itself to admin');
select pg_temp.expect_denied($$insert into public.mvl_staff values ('f0000000-0000-0000-0000-000000000001', 'tester')$$, 'tester cannot grant access to others');
select pg_temp.expect_denied($$select public.mvl_reserve_ai_capture('e0000000-0000-0000-0000-000000000006','text',0,'gemini','gemini-2.5-flash')$$, 'tester cannot bypass the Edge Function to reserve directly');
select pg_temp.expect((select count(*) = 0 from public.notes where user_id <> 'e0000000-0000-0000-0000-000000000006'), 'tester sees no other user''s notes');
select pg_temp.expect((select count(*) = 0 from public.mvl_ai_usage where user_id <> 'e0000000-0000-0000-0000-000000000006'), 'tester sees no other user''s usage');
select set_config('request.jwt.claims', '', false);
reset role;

-- ===================== Account deletion =====================
delete from auth.users where id = 'f0000000-0000-0000-0000-000000000001';
select pg_temp.expect((select count(*) = 0 from public.mvl_daily_activity where user_id = 'f0000000-0000-0000-0000-000000000001'), 'deleting an account removes its activity rows');
select pg_temp.expect((select count(*) >= 8 from public.mvl_ai_usage where user_id is null), 'usage cost records kept anonymised after account deletion');

\echo 'ALL FINANCIAL CONTROL TESTS PASSED'
