-- Plans (free/plus/pro), caps and Bring Your Own AI tests (migration 20261122000001).
-- Run after all migrations (scripts/test-db.sh). Keys used here are placeholders, never real keys.
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
create or replace function pg_temp.expect_error_like(sql text, pattern text, label text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if sqlerrm like pattern then raise notice 'PASS  %', label; return; end if;
    raise exception 'FAIL  % (wrong error: %)', label, sqlerrm;
  end;
  raise exception 'FAIL  % (statement succeeded but should have failed)', label;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.as_nobody() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.set_plan(uid uuid, p text) returns void language sql as $$
  update public.subscriptions set plan = p, status = 'active', current_period_end = case when p = 'free' then null else now() + interval '30 days' end
  where user_id = uid $$;

-- Users: U1 (free, will connect a key), U2 (free, other user), S (staff tester).
insert into auth.users (id, email) values
  ('a6000000-0000-0000-0000-000000000001', 'u1@test'),
  ('a6000000-0000-0000-0000-000000000002', 'u2@test'),
  ('a6000000-0000-0000-0000-000000000003', 's@test');
insert into public.mvl_staff (user_id, role) values ('a6000000-0000-0000-0000-000000000003', 'tester');

-- ===================== Plans and configurable limits =====================
select pg_temp.expect((select string_agg(plan, ',' order by plan) = 'free,plus,pro' from public.mvl_plan_limits), 'plans are exactly free, plus, pro');
select pg_temp.expect((select max_active_reminders = 10 and max_upcoming_events = 20 from public.mvl_plan_limits where plan = 'free'), 'free caps: 10 active reminders, 20 upcoming events');
select pg_temp.expect((select max_active_reminders is null and max_upcoming_events is null from public.mvl_plan_limits where plan = 'plus'), 'plus: no reminder/event caps');
select pg_temp.expect((select byoai_max_capture_seconds = 600 and byoai_captures_per_day = 200 from public.mvl_plan_limits where plan = 'pro'), 'pro: longer recordings and more captures per day');
select pg_temp.expect((select count(*) = 0 from public.mvl_plan_limits where byoai_captures_per_day is null or byoai_captures_per_hour is null), 'no plan has unlimited BYOAI captures (server work is never unlimited)');
select pg_temp.expect((select currency = 'USD' and amount_cents = 499 from public.mvl_plan_prices where plan = 'plus' and billing_interval = 'month'), 'proposed Plus price recorded as 4.99 USD (finance estimates only)');
select pg_temp.expect_error_like($$insert into public.subscriptions (user_id, plan) values ('a6000000-0000-0000-0000-000000000009', 'premium')$$, '%', 'the retired premium plan is rejected by the database');
select pg_temp.expect((select byoai_mode = 'admins_only' and billing_grace_days = 7 from public.mvl_app_settings), 'defaults: BYOAI admins_only, 7-day payment grace');

-- ===================== Caps on reminders and events =====================
update public.mvl_plan_limits set max_active_reminders = 2, max_upcoming_events = 2 where plan = 'free';
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
insert into public.reminders (user_id, title, remind_at, timezone) values
  ('a6000000-0000-0000-0000-000000000001', 'r1', now() + interval '1 day', 'UTC'),
  ('a6000000-0000-0000-0000-000000000001', 'r2', now() + interval '2 days', 'UTC');
select pg_temp.expect_error_like($$insert into public.reminders (user_id, title, remind_at, timezone) values ('a6000000-0000-0000-0000-000000000001', 'r3', now() + interval '3 days', 'UTC')$$,
  'PLAN_LIMIT_REMINDERS%', 'free: the reminder over the cap is refused with PLAN_LIMIT_REMINDERS');
update public.reminders set status = 'done' where title = 'r1';
insert into public.reminders (user_id, title, remind_at, timezone) values ('a6000000-0000-0000-0000-000000000001', 'r3', now() + interval '3 days', 'UTC');
select pg_temp.expect((select count(*) = 3 from public.reminders), 'completing a reminder frees a slot');
select pg_temp.expect_error_like($$update public.reminders set status = 'scheduled' where title = 'r1'$$, 'PLAN_LIMIT_REMINDERS%', 'reopening a reminder over the cap is refused');
insert into public.events (user_id, title, starts_at) values
  ('a6000000-0000-0000-0000-000000000001', 'e1', now() + interval '1 day'),
  ('a6000000-0000-0000-0000-000000000001', 'e2', now() + interval '2 days'),
  ('a6000000-0000-0000-0000-000000000001', 'past', now() - interval '2 days');
select pg_temp.expect_error_like($$insert into public.events (user_id, title, starts_at) values ('a6000000-0000-0000-0000-000000000001', 'e3', now() + interval '3 days')$$,
  'PLAN_LIMIT_EVENTS%', 'free: the upcoming event over the cap is refused with PLAN_LIMIT_EVENTS');
insert into public.events (user_id, title, starts_at) values ('a6000000-0000-0000-0000-000000000001', 'old', now() - interval '5 days');
select pg_temp.expect((select count(*) = 4 from public.events), 'past events never count against the cap');
select pg_temp.as_nobody();
select pg_temp.set_plan('a6000000-0000-0000-0000-000000000001', 'plus');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
insert into public.events (user_id, title, starts_at) values ('a6000000-0000-0000-0000-000000000001', 'e3', now() + interval '3 days');
insert into public.reminders (user_id, title, remind_at, timezone) values ('a6000000-0000-0000-0000-000000000001', 'r4', now() + interval '4 days', 'UTC');
select pg_temp.expect((select count(*) = 3 from public.events where starts_at > now()), 'plus: no event cap');
select pg_temp.as_nobody();
select pg_temp.set_plan('a6000000-0000-0000-0000-000000000001', 'free');
select pg_temp.expect((select count(*) = 3 from public.events where user_id = 'a6000000-0000-0000-0000-000000000001' and starts_at > now()), 'downgrade keeps every existing event (nothing is deleted)');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select pg_temp.expect_error_like($$insert into public.events (user_id, title, starts_at) values ('a6000000-0000-0000-0000-000000000001', 'e4', now() + interval '4 days')$$,
  'PLAN_LIMIT_EVENTS%', 'after a downgrade, new items above the cap are refused');
select pg_temp.expect((public.mvl_my_usage()->>'max_upcoming_events')::int = 2 and (public.mvl_my_usage()->>'upcoming_events')::int = 3, 'my_usage reports the cap and the current count');
select pg_temp.as_nobody();
update public.mvl_plan_limits set max_active_reminders = 10, max_upcoming_events = 20 where plan = 'free';

-- ===================== BYOAI: who can reach a key =====================
select pg_temp.expect(not has_function_privilege('authenticated', 'public.mvl_byoai_get_key(uuid,text)', 'execute'), 'get_key: authenticated has no EXECUTE');
select pg_temp.expect(not has_function_privilege('anon', 'public.mvl_byoai_get_key(uuid,text)', 'execute'), 'get_key: anon has no EXECUTE');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.mvl_byoai_set_key(uuid,text,text,text)', 'execute'), 'set_key: authenticated has no EXECUTE');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.mvl_reserve_byoai_capture(uuid,text,numeric)', 'execute'), 'reserve_byoai: authenticated has no EXECUTE');
select pg_temp.expect(has_function_privilege('service_role', 'public.mvl_byoai_get_key(uuid,text)', 'execute'), 'get_key: service_role has EXECUTE');
select pg_temp.expect(not has_table_privilege('authenticated', 'vault.secrets', 'select'), 'authenticated cannot read vault.secrets');
select pg_temp.expect(not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select'), 'authenticated cannot read vault.decrypted_secrets');
select pg_temp.expect(not has_column_privilege('authenticated', 'public.mvl_ai_connections', 'vault_secret_id', 'select'), 'authenticated cannot read the Vault secret id column');

set role service_role;
select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000001', 'openai', 'sk-proj-PLACEHOLDERplaceholder0001', '0001');
select pg_temp.expect(public.mvl_byoai_get_key('a6000000-0000-0000-0000-000000000001', 'openai') = 'sk-proj-PLACEHOLDERplaceholder0001', 'service role stores and reads back the key');
reset role;
select pg_temp.expect((select count(*) = 1 from vault.secrets where secret like 'sk-proj-PLACEHOLDER%0001'), 'the key lives in Vault');
select pg_temp.expect((select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'mvl_ai_connections' and column_name ilike '%key' and column_name <> 'key_hint'), 'no plaintext key column on the connections table');
set role service_role;
select pg_temp.expect_error_like($$select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000001', 'openai', 'sk-proj with space inside xxxxxxxx', 'abcd')$$, 'invalid key%', 'a key with whitespace inside is refused');
select pg_temp.expect_error_like($$select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000001', 'anthropic', 'sk-proj-PLACEHOLDERplaceholder9999', '9999')$$, 'invalid key%', 'only the openai provider is accepted');
-- Replacing the key keeps one connection and one secret.
select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000001', 'openai', 'sk-proj-PLACEHOLDERplaceholder0002', '0002');
reset role;
select pg_temp.expect((select count(*) = 1 from public.mvl_ai_connections where user_id = 'a6000000-0000-0000-0000-000000000001')
  and (select count(*) = 1 from vault.secrets), 'replacing a key keeps one connection and one Vault secret');

-- What users see: their own hint and status, never the key or the secret id.
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select pg_temp.expect((select key_hint = '0002' and status = 'active' from public.mvl_ai_connections), 'owner sees the 4-character hint and the status');
select pg_temp.expect_denied($$select vault_secret_id from public.mvl_ai_connections$$, 'owner cannot select the Vault secret id');
select pg_temp.expect_denied($$select * from vault.decrypted_secrets$$, 'owner cannot read Vault');
select pg_temp.expect_denied($$select public.mvl_byoai_get_key('a6000000-0000-0000-0000-000000000001', 'openai')$$, 'owner cannot call get_key (keys never go back to the browser)');
select pg_temp.expect_denied($$insert into public.mvl_ai_connections (user_id, provider, vault_secret_id, key_hint) values ('a6000000-0000-0000-0000-000000000001', 'openai', gen_random_uuid(), 'abcd')$$, 'owner cannot write connection rows directly');
select pg_temp.expect((public.mvl_my_usage()->>'byoai_connected')::boolean, 'my_usage reports the connection');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000002');
select pg_temp.expect((select count(*) = 0 from public.mvl_ai_connections), 'another user sees no connection rows of U1');
select pg_temp.expect(not (public.mvl_my_usage()->>'byoai_connected')::boolean, 'another user is not connected');
select pg_temp.as_nobody();
set role anon;
select pg_temp.expect_denied($$select key_hint from public.mvl_ai_connections$$, 'anon cannot read connections');
reset role;

-- Plan limit on connections.
update public.mvl_plan_limits set max_ai_connections = 0 where plan = 'free';
set role service_role;
select pg_temp.expect_error_like($$select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000002', 'openai', 'sk-proj-PLACEHOLDERplaceholder0003', '0003')$$,
  'PLAN_LIMIT_AI_CONNECTIONS%', 'connections beyond the plan limit are refused');
reset role;
update public.mvl_plan_limits set max_ai_connections = 1 where plan = 'free';

-- ===================== BYOAI: switches and rate limits =====================
set role service_role;
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'voice', 10)->>'reason') = 'ai_test_mode', 'byoai admins_only: a normal user is refused');
reset role;
update public.mvl_app_settings set byoai_mode = 'everyone';
set role service_role;
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000002', 'voice', 10)->>'reason') = 'ai_key_required', 'no key connected: refused with ai_key_required');
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'voice', 200)->>'reason') = 'audio_too_long', 'free: a 200 s recording is over the 120 s BYOAI limit');
do $$ declare r jsonb; begin
  r := public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'voice', 30);
  perform pg_temp.expect((r->>'ok')::boolean, 'connected free user: capture reserved');
  perform public.mvl_record_byoai_call((r->>'reservation_id')::uuid, 30, 1200, 300);
  perform public.mvl_finish_byoai_capture((r->>'reservation_id')::uuid, 'ok');
end $$;
reset role;
select pg_temp.expect((select input_tokens = 1200 and output_tokens = 300 and status = 'ok' from public.mvl_byoai_usage where status = 'ok'), 'usage recorded with tokens');
select pg_temp.expect((select count(*) = 0 from public.mvl_ai_usage where user_id = 'a6000000-0000-0000-0000-000000000001'), 'BYOAI usage never touches the platform AI budget table');
update public.mvl_plan_limits set byoai_captures_per_hour = 2 where plan = 'free';
set role service_role;
select public.mvl_finish_byoai_capture((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'text', 0)->>'reservation_id')::uuid, 'failed', 'upstream_500');
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'text', 0)->>'reason') = 'rate_limited_hour', 'hourly BYOAI limit enforced (failed attempts count too)');
reset role;
update public.mvl_plan_limits set byoai_captures_per_hour = 5 where plan = 'free';
update public.mvl_app_settings set ai_mode = 'off';
set role service_role;
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000001', 'text', 0)->>'reason') = 'ai_paused', 'the global kill switch also stops BYOAI');
reset role;
update public.mvl_app_settings set ai_mode = 'admins_only', byoai_mode = 'off';
set role service_role;
select pg_temp.expect((public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000003', 'text', 0)->>'reason') = 'byoai_off', 'byoai off: even staff are refused');
reset role;
update public.mvl_app_settings set byoai_mode = 'admins_only';
-- An invalid key is not used.
set role service_role;
select public.mvl_byoai_mark_invalid('a6000000-0000-0000-0000-000000000001', 'openai');
select pg_temp.expect(public.mvl_byoai_get_key('a6000000-0000-0000-0000-000000000001', 'openai') is null, 'a key marked invalid is never returned');
reset role;
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select pg_temp.expect((public.mvl_my_usage()->>'byoai_key_invalid')::boolean, 'my_usage tells the user their key was rejected');
select pg_temp.expect((select count(*) > 0 from public.mvl_byoai_usage) and (select count(*) = 0 from public.mvl_byoai_usage where user_id <> 'a6000000-0000-0000-0000-000000000001'),
  'a user reads only their own BYOAI usage rows');
select pg_temp.expect_denied($$update public.mvl_byoai_usage set status = 'ok'$$, 'a user cannot alter usage records');
select pg_temp.as_nobody();
set role service_role;
select public.mvl_reserve_byoai_capture('a6000000-0000-0000-0000-000000000003', 'text', 0);
reset role;
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select pg_temp.expect((select count(*) = 0 from public.mvl_byoai_usage where user_id = 'a6000000-0000-0000-0000-000000000003'), 'U1 cannot see the staff user''s usage rows');
select pg_temp.as_nobody();

-- ===================== Disconnect and account deletion remove the secret =====================
set role service_role;
select pg_temp.expect(public.mvl_byoai_delete_key('a6000000-0000-0000-0000-000000000001', 'openai'), 'disconnect removes the connection');
reset role;
select pg_temp.expect((select count(*) = 0 from vault.secrets), 'disconnect deletes the Vault secret');
set role service_role;
select public.mvl_byoai_set_key('a6000000-0000-0000-0000-000000000002', 'openai', 'sk-proj-PLACEHOLDERplaceholder0004', '0004');
reset role;
delete from auth.users where id = 'a6000000-0000-0000-0000-000000000002';
select pg_temp.expect((select count(*) = 0 from public.mvl_ai_connections where user_id = 'a6000000-0000-0000-0000-000000000002')
  and (select count(*) = 0 from vault.secrets), 'account deletion removes the connection and its Vault secret');

\echo 'ALL PLANS AND BYOAI TESTS PASSED'
