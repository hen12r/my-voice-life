-- Reminder notifications (Web Push) tests (migration 20261128000001).
-- Run after all migrations (scripts/test-db.sh). Keys and endpoints are placeholders.
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.as_nobody() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', false); end $$;

-- Valid-looking placeholder keys: 87 and 22 base64url characters.
\set k '''BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'''
\set a '''AAAAAAAAAAAAAAAAAAAAAA'''

insert into auth.users (id, email) values
  ('a7000000-0000-0000-0000-000000000001', 'p1@test'),
  ('a7000000-0000-0000-0000-000000000002', 'p2@test');

-- ===================== Subscribing =====================
select pg_temp.as_user('a7000000-0000-0000-0000-000000000001');
select pg_temp.expect(public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/dev1', :k, :a, 'Chrome') is not null, 'a user can turn notifications on for a browser');
select pg_temp.expect((select count(*) = 1 from public.mvl_push_subscriptions), 'the owner sees their own device');
select pg_temp.expect(public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/dev1', :k, :a, 'Chrome') is not null
  and (select count(*) = 1 from public.mvl_push_subscriptions), 'subscribing the same browser twice keeps one row');
select pg_temp.expect_error_like($$select public.mvl_push_subscribe('https://evil.example/x', $$ || quote_literal(:k) || $$, $$ || quote_literal(:a) || $$)$$, '%check constraint%', 'an endpoint outside the browsers'' push services is refused (SSRF guard)');
select pg_temp.expect_error_like($$select public.mvl_push_subscribe('http://fcm.googleapis.com/fcm/send/x', $$ || quote_literal(:k) || $$, $$ || quote_literal(:a) || $$)$$, '%check constraint%', 'a plain-http endpoint is refused');
select pg_temp.expect_error_like($$select public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/x', 'short', $$ || quote_literal(:a) || $$)$$, '%check constraint%', 'a malformed browser key is refused');
select pg_temp.expect_denied($$insert into public.mvl_push_subscriptions (user_id, endpoint, p256dh, auth) values ('a7000000-0000-0000-0000-000000000001', 'https://fcm.googleapis.com/fcm/send/z', 'x', 'y')$$, 'clients cannot write the table directly');
select pg_temp.expect_denied($$select p256dh from public.mvl_push_subscriptions$$, 'clients cannot read the browser encryption keys back');
select pg_temp.expect_denied($$select * from public.mvl_push_claim_due(10)$$, 'clients cannot claim reminders to send');
select pg_temp.expect_denied($$select * from public.mvl_push_targets(array['a7000000-0000-0000-0000-000000000001'::uuid])$$, 'clients cannot list push targets');
select pg_temp.expect_denied($$select public.mvl_push_record_result(gen_random_uuid(), true, false)$$, 'clients cannot record send results');
-- Device cap.
do $$ begin
  for i in 2..10 loop perform public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/dev' || i, repeat('B', 87), repeat('A', 22)); end loop;
end $$;
select pg_temp.expect_error_like($$select public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/dev11', $$ || quote_literal(:k) || $$, $$ || quote_literal(:a) || $$)$$, 'PUSH_LIMIT_DEVICES%', 'at most 10 devices per user');
select public.mvl_push_unsubscribe('https://fcm.googleapis.com/fcm/send/dev' || i) from generate_series(3, 10) i;
select pg_temp.expect((select count(*) = 2 from public.mvl_push_subscriptions), 'turning a device off removes it');

-- Isolation: user 2 sees nothing of user 1, cannot unsubscribe user 1's device.
select pg_temp.as_user('a7000000-0000-0000-0000-000000000002');
select pg_temp.expect((select count(*) = 0 from public.mvl_push_subscriptions), 'another user cannot see someone else''s devices');
select public.mvl_push_unsubscribe('https://fcm.googleapis.com/fcm/send/dev2');
select pg_temp.as_nobody();
select pg_temp.expect((select count(*) = 1 from public.mvl_push_subscriptions where endpoint like '%/dev2'), 'another user cannot turn off someone else''s device');
-- Same browser, new account → the endpoint moves to the account signed in now.
select pg_temp.as_user('a7000000-0000-0000-0000-000000000002');
select public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/dev2', :k, :a, 'Firefox');
select pg_temp.as_nobody();
select pg_temp.expect((select user_id = 'a7000000-0000-0000-0000-000000000002' from public.mvl_push_subscriptions where endpoint like '%/dev2'), 'a browser endpoint follows the account that signed in last');
set role anon;
select pg_temp.expect_denied($$select public.mvl_push_subscribe('https://fcm.googleapis.com/fcm/send/anon', 'x', 'y')$$, 'anonymous visitors cannot subscribe');
reset role;

-- ===================== Claiming due reminders =====================
insert into public.reminders (user_id, title, remind_at, timezone, recurrence) values
  ('a7000000-0000-0000-0000-000000000001', 'due now', now() - interval '2 minutes', 'UTC', 'none'),
  ('a7000000-0000-0000-0000-000000000001', 'due daily', now() - interval '1 minute', 'UTC', 'daily'),
  ('a7000000-0000-0000-0000-000000000001', 'too old', now() - interval '3 hours', 'UTC', 'none'),
  ('a7000000-0000-0000-0000-000000000001', 'future', now() + interval '1 hour', 'UTC', 'none'),
  ('a7000000-0000-0000-0000-000000000001', 'done one', now() - interval '1 minute', 'UTC', 'none');
update public.reminders set status = 'done' where title = 'done one';
-- User 2's device exists but they have no due reminder; a third user has a due reminder but no device.
insert into auth.users (id, email) values ('a7000000-0000-0000-0000-000000000003', 'p3@test');
insert into public.reminders (user_id, title, remind_at, timezone) values ('a7000000-0000-0000-0000-000000000003', 'no device', now() - interval '1 minute', 'UTC');

select pg_temp.as_service();
create temp table claimed as select * from public.mvl_push_claim_due(100);
select pg_temp.expect((select string_agg(title, ',' order by title) = 'due daily,due now' from claimed), 'claims only scheduled reminders due within the last hour, for users with a device');
select pg_temp.expect((select count(*) = 0 from public.mvl_push_claim_due(100)), 'a claimed reminder is never sent twice');
select pg_temp.expect((select count(*) = 1 and bool_and(endpoint like '%/dev1') from public.mvl_push_targets(array['a7000000-0000-0000-0000-000000000001'::uuid])), 'targets: the owner''s current devices only');
select pg_temp.as_nobody();
select pg_temp.expect((select remind_at < now() and recurrence = 'daily' from public.reminders where title = 'due daily'), 'a recurring reminder is not moved by the sender (the user completes it)');
-- The user later moves the reminder to a new time (after the last alert); when that time is due,
-- it is sent again. Simulated by putting the earlier alert 30 minutes in the past.
update public.reminders set last_notified_at = now() - interval '30 minutes', remind_at = now() - interval '10 seconds' where title = 'due now';
select pg_temp.as_service();
select pg_temp.expect((select count(*) = 1 from public.mvl_push_claim_due(100)), 'a reminder moved to a new due time is sent again');

-- ===================== Recording results =====================
select public.mvl_push_record_result((select id from public.mvl_push_subscriptions where endpoint like '%/dev1'), true, false);
select pg_temp.expect((select last_success_at is not null and failure_count = 0 from public.mvl_push_subscriptions where endpoint like '%/dev1'), 'a delivered message records success');
select public.mvl_push_record_result((select id from public.mvl_push_subscriptions where endpoint like '%/dev1'), false, false);
select pg_temp.expect((select failure_count = 1 from public.mvl_push_subscriptions where endpoint like '%/dev1'), 'a failure is counted');
select public.mvl_push_record_result((select id from public.mvl_push_subscriptions where endpoint like '%/dev1'), false, true);
select pg_temp.expect((select count(*) = 0 from public.mvl_push_subscriptions where endpoint like '%/dev1'), 'a gone subscription (404/410) is deleted');
select pg_temp.as_nobody();

-- ===================== Account deletion =====================
delete from auth.users where id = 'a7000000-0000-0000-0000-000000000002';
select pg_temp.expect((select count(*) = 0 from public.mvl_push_subscriptions where user_id = 'a7000000-0000-0000-0000-000000000002'), 'deleting an account deletes its devices');

select 'PUSH TESTS PASSED';
