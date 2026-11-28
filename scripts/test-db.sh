#!/usr/bin/env bash
# Database tests against a THROWAWAY local Postgres (with a Supabase shim). Never point at production.
# Requires PGHOST/PGPORT/PGUSER for a local server. Scenarios:
#   fresh   — empty project: migration (atomic, re-runnable) + RLS/isolation/quota suite
#   legacy  — simulated FitPick project: migration must keep all data and close the old holes
#   guard   — conflicting pre-existing table: migration must abort and change nothing
set -euo pipefail
cd "$(dirname "$0")/.."
QUIET="-c client_min_messages=warning"
MIGRATIONS=(supabase/migrations/*.sql)

reset_db() {
  PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $1" -c "create database $1"
  for r in anon authenticated service_role; do PGOPTIONS="$QUIET" psql -q -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done
  PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q -d "$1" -f supabase/tests/supabase_shim.sql
}
# Stops at the first failing migration, like `supabase db push` does.
migrate() { for f in "${MIGRATIONS[@]}"; do PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d "$1" -f "$f" || return 1; done; }
run_test() { psql -v ON_ERROR_STOP=1 -d "$1" -f "$2" 2>&1 | sed -n 's/^.*NOTICE:  //p; /PASSED/p; /FAIL/p; /ERROR/p'; }

echo "== Scenario: fresh project"
reset_db mvl_test
migrate mvl_test && migrate mvl_test && echo "Migration applies atomically and is re-runnable"
run_test mvl_test supabase/tests/rls_test.sql

run_test mvl_test supabase/tests/financial_test.sql

run_test mvl_test supabase/tests/openai_multilingual_test.sql

run_test mvl_test supabase/tests/billing_test.sql

run_test mvl_test supabase/tests/plans_byoai_test.sql

run_test mvl_test supabase/tests/push_test.sql

echo "== Scenario: rollback of migration 7 (push), round trip"
reset_db mvl_test
migrate mvl_test
R="psql -v ON_ERROR_STOP=1 -qtA -d mvl_test"
$R -c "insert into auth.users (id, email) values ('55555555-0000-0000-0000-000000000001','rb7@test')" \
   -c "insert into public.reminders (user_id, title, remind_at, timezone, last_notified_at) values ('55555555-0000-0000-0000-000000000001','keep me',now(),'UTC',now())" \
   -c "insert into public.mvl_push_subscriptions (user_id, endpoint, p256dh, auth) values ('55555555-0000-0000-0000-000000000001','https://fcm.googleapis.com/fcm/send/rb7',repeat('B',87),repeat('A',22))" >/dev/null
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f supabase/rollback/rollback_20261128_migration_7_push.sql
CHECK=$($R -c "select to_regclass('public.mvl_push_subscriptions') is null
  and to_regprocedure('public.mvl_push_claim_due(integer)') is null
  and to_regprocedure('public.mvl_push_subscribe(text,text,text,text)') is null
  and (select count(*) = 1 from public.reminders where title = 'keep me' and last_notified_at is not null)")
[ "$CHECK" = t ] || { echo "FAIL  rollback 7 did not remove push objects or touched reminders"; exit 1; }
echo "PASS  rollback 7 removes the push table and functions, and keeps reminders intact"
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f supabase/migrations/20261128000001_mvl_push.sql
[ "$($R -c "select to_regclass('public.mvl_push_subscriptions') is not null")" = t ] || { echo "FAIL  re-apply after rollback 7"; exit 1; }
echo "PASS  migration 7 re-applies cleanly after a rollback"
echo "ALL PUSH ROLLBACK TESTS PASSED"

echo "== Scenario: rollback of migrations 3-4 (round trip, and refusals that protect data)"
reset_db mvl_test
migrate mvl_test
R="psql -v ON_ERROR_STOP=1 -qtA -d mvl_test"
RB=supabase/rollback/rollback_20261119_migrations_3_4.sql
$R -c "insert into auth.users (id, email) values ('77777777-0000-0000-0000-000000000001','rb@test')"
$R -c "insert into public.notes (user_id, title, body) values ('77777777-0000-0000-0000-000000000001','keep me','x')" >/dev/null
NOTES_BEFORE=$($R -c "select count(*) from public.notes"); [ "$NOTES_BEFORE" -ge 1 ] || { echo "FAIL  test note not created"; exit 1; }
# Refusal 1: a profile already uses a language outside en/fr/rw.
$R -c "update public.profiles set ui_language = 'sw' where id = '77777777-0000-0000-0000-000000000001'"
if PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB" >/dev/null 2>&1; then echo "FAIL  rollback should refuse when a profile uses sw"; exit 1; fi
[ "$($R -c "select count(*) from information_schema.columns where table_name='profiles' and column_name='speech_languages'")" = 1 ] || { echo "FAIL  refused rollback changed the schema"; exit 1; }
echo "PASS  rollback refuses (and changes nothing) when a profile uses a language outside en/fr/rw"
$R -c "update public.profiles set ui_language = 'en' where id = '77777777-0000-0000-0000-000000000001'"
# Refusal 2: OpenAI prices already referenced by recorded usage.
$R -c "update public.mvl_app_settings set ai_mode = 'on'" \
   -c "select public.mvl_finish_ai_capture((public.mvl_reserve_ai_capture('77777777-0000-0000-0000-000000000001','text',0,'openai','gpt-6-luna')->>'reservation_id')::uuid, 'ok')" >/dev/null
if PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB" >/dev/null 2>&1; then echo "FAIL  rollback should refuse when cost history references OpenAI prices"; exit 1; fi
echo "PASS  rollback refuses (and changes nothing) when cost history references the OpenAI prices"
$R -c "delete from public.mvl_ai_usage where user_id = '77777777-0000-0000-0000-000000000001'" -c "update public.mvl_app_settings set ai_mode = 'admins_only'"
# Clean rollback.
$R -c "update public.profiles set speech_languages = array['fr','en'] where id = '77777777-0000-0000-0000-000000000001'"
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB"
CHECK=$($R -c "select
  (select count(*) from information_schema.columns where table_name='profiles' and column_name='speech_languages') = 0
  and (select count(*) from information_schema.columns where table_name='mvl_price_book' and column_name='audio_usd_per_minute') = 0
  and to_regprocedure('public.mvl_record_ai_transcription(uuid,numeric)') is null
  and to_regprocedure('public.mvl_valid_language_codes(text[])') is null
  and (select count(*) from public.mvl_price_book where provider = 'openai') = 0
  and (select count(*) from pg_constraint where conname in ('profiles_ui_language_chk','profiles_speech_language_chk')) = 2
  and position('audio_usd_per_minute' in pg_get_functiondef('public.mvl_capture_cost_ceiling(public.mvl_price_book,numeric)'::regprocedure)) = 0
  and not has_function_privilege('authenticated', 'public.mvl_capture_cost_ceiling(public.mvl_price_book,numeric)', 'execute')
  and (select count(*) from public.notes) = $NOTES_BEFORE")
[ "$CHECK" = t ] || { echo "FAIL  rollback did not restore the pre-migration-3 state"; exit 1; }
echo "PASS  rollback restores the pre-migration-3 state (columns, functions, prices, constraints, lockdown) and keeps notes"
# Re-apply after rollback.
for f in supabase/migrations/20261119000001_*.sql supabase/migrations/20261119000002_*.sql; do PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$f"; done
[ "$($R -c "select count(*) from public.mvl_price_book where provider='openai'")" = 2 ] || { echo "FAIL  re-apply after rollback"; exit 1; }
echo "PASS  migrations 3-4 re-apply cleanly after a rollback"
echo "ALL ROLLBACK TESTS PASSED"

echo "== Scenario: rollback of migration 5 (billing)"
reset_db mvl_test
migrate mvl_test
R="psql -v ON_ERROR_STOP=1 -qtA -d mvl_test"
RB5=supabase/rollback/rollback_20261120_migration_5_billing.sql
$R -c "insert into auth.users (id, email) values ('66666666-0000-0000-0000-000000000001','rb5@test')"
$R -c "set role service_role; select public.mvl_billing_link_customer('66666666-0000-0000-0000-000000000001','cus_Rb5')" >/dev/null
if PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB5" >/dev/null 2>&1; then echo "FAIL  billing rollback should refuse when a Stripe customer is linked"; exit 1; fi
[ "$($R -c "select count(*) from information_schema.tables where table_name='mvl_stripe_events'")" = 1 ] || { echo "FAIL  refused billing rollback changed the schema"; exit 1; }
echo "PASS  billing rollback refuses (and changes nothing) once a Stripe customer is linked"
$R -c "update public.subscriptions set stripe_customer_id = null"
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB5"
CHECK5=$($R -c "select to_regclass('public.mvl_stripe_events') is null
  and to_regprocedure('public.mvl_billing_link_customer(uuid,text)') is null
  and (select count(*) from information_schema.columns where table_name='subscriptions' and column_name in ('cancel_at_period_end','stripe_price_id','stripe_livemode','stripe_synced_at')) = 0
  and (select count(*) from pg_constraint where conname = 'subscriptions_status_check') = 1
  and public.effective_plan('66666666-0000-0000-0000-000000000001') = 'free'")
[ "$CHECK5" = t ] || { echo "FAIL  billing rollback did not restore the previous state"; exit 1; }
echo "PASS  billing rollback restores the previous state"
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f supabase/migrations/20261120000001_mvl_stripe_billing.sql
echo "PASS  migration 5 re-applies cleanly after a rollback"
echo "ALL BILLING ROLLBACK TESTS PASSED"

echo "== Scenario: rollback of migration 6 (plans + BYOAI)"
reset_db mvl_test
migrate mvl_test
R="psql -v ON_ERROR_STOP=1 -qtA -d mvl_test"
RB6=supabase/rollback/rollback_20261122_migration_6_plans_byoai.sql
rb6() { PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f "$RB6"; }
$R -c "insert into auth.users (id, email) values ('55555555-0000-0000-0000-000000000001','rb6@test'), ('55555555-0000-0000-0000-000000000002','rb6b@test')"
$R -c "insert into public.notes (user_id, title, body) values ('55555555-0000-0000-0000-000000000001','keep me','x')" >/dev/null
# Refusal 1: a user has connected an AI key.
$R -c "set role service_role" -c "select public.mvl_byoai_set_key('55555555-0000-0000-0000-000000000001','openai','sk-proj-PLACEHOLDERrollback0001','0001')" >/dev/null
if rb6 >/dev/null 2>&1; then echo "FAIL  rollback 6 should refuse while AI keys are stored"; exit 1; fi
[ "$($R -c "select count(*) from public.mvl_ai_connections")" = 1 ] || { echo "FAIL  refused rollback changed data"; exit 1; }
echo "PASS  rollback 6 refuses (and changes nothing) while users have stored AI keys"
$R -c "set role service_role" -c "select public.mvl_byoai_delete_key('55555555-0000-0000-0000-000000000001','openai')" >/dev/null
# Refusal 2: a Stripe-linked Plus subscription.
$R -c "update public.subscriptions set plan = 'plus', status = 'active', stripe_customer_id = 'cus_Rb6', stripe_subscription_id = 'sub_Rb6', current_period_end = now() + interval '30 days' where user_id = '55555555-0000-0000-0000-000000000002'"
if rb6 >/dev/null 2>&1; then echo "FAIL  rollback 6 should refuse with a Stripe-linked plus subscription"; exit 1; fi
echo "PASS  rollback 6 refuses (and changes nothing) with a Stripe-linked plus subscription"
$R -c "update public.subscriptions set plan = 'free', stripe_customer_id = null, stripe_subscription_id = null, current_period_end = null where user_id = '55555555-0000-0000-0000-000000000002'"
# Clean rollback (an unlinked pro row becomes premium).
$R -c "update public.subscriptions set plan = 'pro' where user_id = '55555555-0000-0000-0000-000000000001'"
rb6
CHECK=$($R -c "select
  (select string_agg(plan, ',' order by plan) from public.mvl_plan_limits) = 'free,premium'
  and (select plan from public.subscriptions where user_id = '55555555-0000-0000-0000-000000000001') = 'premium'
  and to_regclass('public.mvl_ai_connections') is null and to_regclass('public.mvl_byoai_usage') is null
  and to_regprocedure('public.mvl_billing_apply_subscription(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid)') is not null
  and has_function_privilege('service_role', 'public.mvl_billing_apply_subscription(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.mvl_billing_apply_subscription(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid)', 'execute')
  and to_regprocedure('public.mvl_billing_apply_subscription_v2(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid,text)') is null
  and (select count(*) from information_schema.columns where table_name = 'mvl_plan_limits' and column_name like 'byoai%') = 0
  and (select count(*) from information_schema.columns where table_name = 'mvl_app_settings' and column_name in ('byoai_mode','billing_grace_days')) = 0
  and position('past_due' in pg_get_functiondef('public.effective_plan(uuid)'::regprocedure)) = 0
  and position('byoai' in pg_get_functiondef('public.mvl_my_usage()'::regprocedure)) = 0
  and has_function_privilege('authenticated', 'public.mvl_my_usage()', 'execute')
  and (select count(*) from pg_trigger where tgname in ('mvl_reminders_cap','mvl_events_cap')) = 0
  and (select count(*) from public.notes) = 1")
[ "$CHECK" = t ] || { echo "FAIL  rollback 6 did not restore the pre-migration-6 state"; exit 1; }
echo "PASS  rollback 6 restores free/premium, v1 webhook apply, original functions, and keeps notes"
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q --single-transaction -d mvl_test -f supabase/migrations/20261122000001_mvl_plans_byoai.sql
[ "$($R -c "select string_agg(plan, ',' order by plan) from public.mvl_plan_limits")" = "free,plus,pro" ] || { echo "FAIL  re-apply after rollback 6"; exit 1; }
echo "PASS  migration 6 re-applies cleanly after a rollback"
echo "ALL PLANS ROLLBACK TESTS PASSED"

echo "== Scenario: concurrent requests cannot bypass limits or budgets"
reset_db mvl_test
migrate mvl_test
Q2="psql -v ON_ERROR_STOP=1 -qtA -d mvl_test"
$Q2 -c "insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000001','race@test'), ('99999999-0000-0000-0000-000000000002','race2@test')" \
    -c "update public.mvl_app_settings set ai_mode = 'on'" \
    -c "update public.mvl_plan_limits set captures_per_hour = 100, captures_per_day = 100 where plan = 'free'"
# User 1 uses 6 of 7 free captures.
for i in 1 2 3 4 5 6; do
  $Q2 -c "select public.mvl_finish_ai_capture((public.mvl_reserve_ai_capture('99999999-0000-0000-0000-000000000001','text',0,'gemini','gemini-2.5-flash')->>'reservation_id')::uuid, 'ok')" >/dev/null
done
race() {  # two sessions reserve at the same time; the first holds its transaction open for 2 s
  $Q2 -c "begin" -c "select public.mvl_reserve_ai_capture('$1','text',0,'gemini','gemini-2.5-flash')->>'ok'" -c "select pg_sleep(2)" -c "commit" > /tmp/mvl_race_a &
  sleep 0.5
  $Q2 -c "select public.mvl_reserve_ai_capture('$1','text',0,'gemini','gemini-2.5-flash')->>'reason'" > /tmp/mvl_race_b
  wait
}
race 99999999-0000-0000-0000-000000000001
[ "$(grep -c true /tmp/mvl_race_a)" = 1 ] && [ "$(cat /tmp/mvl_race_b)" = "quota_captures" ] \
  && echo "PASS  two simultaneous requests for the last free capture: exactly one succeeds" \
  || { echo "FAIL  race on last capture: A=$(cat /tmp/mvl_race_a) B=$(cat /tmp/mvl_race_b)"; exit 1; }
# Budget race: room for exactly one more worst-case text capture ($0.01219).
$Q2 -c "update public.mvl_app_settings set daily_ai_budget_usd = round(public.mvl_spend_since(date_trunc('day', now())) + 0.02, 2)"
race 99999999-0000-0000-0000-000000000002
[ "$(grep -c true /tmp/mvl_race_a)" = 1 ] && [ "$(cat /tmp/mvl_race_b)" = "budget_daily" ] \
  && echo "PASS  two simultaneous requests for the last budget: exactly one succeeds" \
  || { echo "FAIL  budget race: A=$(cat /tmp/mvl_race_a) B=$(cat /tmp/mvl_race_b)"; exit 1; }
[ "$($Q2 -c "select public.mvl_spend_since(date_trunc('day', now())) <= daily_ai_budget_usd from public.mvl_app_settings")" = t ] \
  && echo "PASS  budget not exceeded after the race" || { echo "FAIL  budget exceeded"; exit 1; }
# BYOAI race: one capture left in the user's hourly limit; two simultaneous requests.
$Q2 -c "insert into auth.users (id, email) values ('99999999-0000-0000-0000-000000000003','race3@test')" \
    -c "update public.mvl_app_settings set byoai_mode = 'everyone'" \
    -c "update public.mvl_plan_limits set byoai_captures_per_hour = 2 where plan = 'free'" \
    -c "set role service_role" \
    -c "select public.mvl_byoai_set_key('99999999-0000-0000-0000-000000000003','openai','sk-proj-PLACEHOLDERracetest0003','0003')" \
    -c "select public.mvl_finish_byoai_capture((public.mvl_reserve_byoai_capture('99999999-0000-0000-0000-000000000003','text',0)->>'reservation_id')::uuid, 'ok')" >/dev/null
$Q2 -c "begin" -c "select public.mvl_reserve_byoai_capture('99999999-0000-0000-0000-000000000003','text',0)->>'ok'" -c "select pg_sleep(2)" -c "commit" > /tmp/mvl_race_a &
sleep 0.5
$Q2 -c "select public.mvl_reserve_byoai_capture('99999999-0000-0000-0000-000000000003','text',0)->>'reason'" > /tmp/mvl_race_b
wait
[ "$(grep -c true /tmp/mvl_race_a)" = 1 ] && [ "$(cat /tmp/mvl_race_b)" = "rate_limited_hour" ] \
  && echo "PASS  two simultaneous BYOAI requests for the last hourly capture: exactly one succeeds" \
  || { echo "FAIL  BYOAI race: A=$(cat /tmp/mvl_race_a) B=$(cat /tmp/mvl_race_b)"; exit 1; }
# Caps race: one reminder slot left on the free plan; two simultaneous inserts.
$Q2 -c "update public.mvl_plan_limits set max_active_reminders = 1 where plan = 'free'"
$Q2 -c "begin" -c "insert into public.reminders (user_id, title, remind_at, timezone) values ('99999999-0000-0000-0000-000000000002','a',now()+interval '1 day','UTC')" -c "select pg_sleep(2)" -c "commit" > /tmp/mvl_race_a 2>&1 &
sleep 0.5
$Q2 -c "insert into public.reminders (user_id, title, remind_at, timezone) values ('99999999-0000-0000-0000-000000000002','b',now()+interval '1 day','UTC')" > /tmp/mvl_race_b 2>&1 || true
wait
[ "$($Q2 -c "select count(*) from public.reminders where user_id = '99999999-0000-0000-0000-000000000002'")" = 1 ] && grep -q PLAN_LIMIT_REMINDERS /tmp/mvl_race_b \
  && echo "PASS  two simultaneous reminders for the last free slot: exactly one is saved" \
  || { echo "FAIL  caps race: B=$(cat /tmp/mvl_race_b)"; exit 1; }
# Push race: two senders claim at the same time; every due reminder is claimed exactly once.
$Q2 -c "insert into public.mvl_push_subscriptions (user_id, endpoint, p256dh, auth) values ('99999999-0000-0000-0000-000000000002','https://fcm.googleapis.com/fcm/send/race',repeat('B',87),repeat('A',22))" \
    -c "update public.mvl_plan_limits set max_active_reminders = null where plan = 'free'" \
    -c "insert into public.reminders (user_id, title, remind_at, timezone) select '99999999-0000-0000-0000-000000000002', 'due ' || g, now() - interval '1 minute', 'UTC' from generate_series(1, 40) g" >/dev/null
$Q2 -c "begin" -c "select count(*) from public.mvl_push_claim_due(25)" -c "select pg_sleep(2)" -c "commit" > /tmp/mvl_race_a &
sleep 0.5
$Q2 -c "select count(*) from public.mvl_push_claim_due(1000)" > /tmp/mvl_race_b
wait
A=$(grep -E '^[0-9]+$' /tmp/mvl_race_a | head -1); B=$(cat /tmp/mvl_race_b)
[ "$((A + B))" = 40 ] && [ "$A" = 25 ] && [ "$($Q2 -c "select count(*) from public.mvl_push_claim_due(1000)")" = 0 ] \
  && echo "PASS  two simultaneous senders: each of 40 due reminders claimed exactly once ($A + $B)" \
  || { echo "FAIL  push race: A=$A B=$B"; exit 1; }
echo "ALL CONCURRENCY TESTS PASSED"

echo "== Scenario: legacy FitPick project"
reset_db mvl_test
PGOPTIONS="$QUIET" psql -v ON_ERROR_STOP=1 -q -d mvl_test -f supabase/tests/legacy_fitpick_fixture.sql
migrate mvl_test
run_test mvl_test supabase/tests/legacy_upgrade_test.sql

echo "== Scenario: conflicting table aborts the migration"
reset_db mvl_test
psql -q -d mvl_test -c "create table public.notes (id serial primary key, text text)"
if migrate mvl_test 2>/tmp/mvl_guard.err; then echo "FAIL  migration should have aborted"; exit 1; fi
grep -q "MVL pre-flight" /tmp/mvl_guard.err && echo "PASS  aborted with pre-flight message"
[ "$(psql -tA -d mvl_test -c "select count(*) from pg_tables where schemaname='public' and (tablename in ('categories','tasks','profiles') or tablename like 'mvl\\_%')")" = "0" ] \
  && echo "PASS  nothing was created (rolled back)" || { echo "FAIL  partial changes left behind"; exit 1; }
echo "ALL GUARD TESTS PASSED"

PGOPTIONS="$QUIET" psql -q -d postgres -c "drop database mvl_test"
