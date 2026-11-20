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
