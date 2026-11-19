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
