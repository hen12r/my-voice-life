-- =====================================================================
-- My Voice Life — reminder notifications (Web Push) (additive, re-runnable)
-- ---------------------------------------------------------------------
--   1. mvl_push_subscriptions: one row per browser/device that turned notifications on.
--      RLS: owners read their own rows. Writes go only through two SECURITY DEFINER functions
--      (subscribe / unsubscribe) that validate everything. Max 10 devices per user.
--      Endpoints are restricted to the major browsers' push services (no arbitrary URL can ever
--      be stored, so the sender can never be made to call one: SSRF guard, also enforced in code).
--   2. mvl_push_claim_due(): service role only. Atomically marks due reminders as notified
--      (reminders.last_notified_at, a column that already exists for this) and returns them.
--      FOR UPDATE SKIP LOCKED + the last_notified_at check = each reminder occurrence is sent at
--      most once, even if two senders run at the same time. Only reminders due within the last
--      hour are sent, so switching notifications on never floods old reminders.
--      Recurring reminders are NOT moved: the user still completes them ("complete → next").
--   3. mvl_push_record_result(): service role only. A 404/410 from the push service deletes the
--      subscription; repeated failures (20) remove it too.
-- Reminder content is never stored here. Nothing is sent until the send-reminders function is
-- deployed AND scheduled (supabase/ops/schedule_send_reminders.sql), both separately approved.
-- =====================================================================

create table if not exists public.mvl_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique
    check (char_length(endpoint) <= 1000
       and endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/'),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),   -- 65-byte P-256 point, base64url
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),       -- 16-byte secret, base64url
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0)
);
create index if not exists mvl_push_subscriptions_user_idx on public.mvl_push_subscriptions (user_id);

alter table public.mvl_push_subscriptions enable row level security;
drop policy if exists "mvl_push_subscriptions: owner can read" on public.mvl_push_subscriptions;
create policy "mvl_push_subscriptions: owner can read" on public.mvl_push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.mvl_push_subscriptions from public, anon, authenticated;
grant select (id, user_id, endpoint, user_agent, created_at, last_success_at) on public.mvl_push_subscriptions to authenticated;

-- Turn notifications on for this browser. A browser endpoint belongs to one browser profile; if
-- another account had registered it on this device, it moves to the account signed in now (so one
-- person's reminders never keep arriving after someone else signs in on that browser).
create or replace function public.mvl_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_id uuid; v_count integer;
begin
  if v_user is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('mvl_push'), hashtext(v_user::text));
  delete from public.mvl_push_subscriptions where endpoint = p_endpoint and user_id <> v_user;
  select id into v_id from public.mvl_push_subscriptions where endpoint = p_endpoint;
  if v_id is not null then
    update public.mvl_push_subscriptions set p256dh = p_p256dh, auth = p_auth, user_agent = left(p_user_agent, 300), failure_count = 0
     where id = v_id;
    return v_id;
  end if;
  select count(*) into v_count from public.mvl_push_subscriptions where user_id = v_user;
  if v_count >= 10 then
    raise exception 'PUSH_LIMIT_DEVICES: notifications are on for 10 devices already' using errcode = 'P0001';
  end if;
  insert into public.mvl_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_user, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.mvl_push_unsubscribe(p_endpoint text)
returns void language sql security definer set search_path = ''
as $$ delete from public.mvl_push_subscriptions where endpoint = p_endpoint and user_id = auth.uid() $$;

-- Sender side (service role only).
create or replace function public.mvl_push_claim_due(p_limit integer default 200)
returns table (reminder_id uuid, owner_id uuid, title text, remind_at timestamptz, timezone text)
language sql security definer set search_path = ''
as $$
  with due as (
    select r.id from public.reminders r
     where r.status = 'scheduled'
       and r.remind_at <= now() and r.remind_at > now() - interval '1 hour'
       and (r.last_notified_at is null or r.last_notified_at < r.remind_at)
       and exists (select 1 from public.mvl_push_subscriptions s where s.user_id = r.user_id)
     order by r.remind_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update of r skip locked
  )
  update public.reminders r set last_notified_at = now()
    from due where r.id = due.id
  returning r.id, r.user_id, r.title, r.remind_at, r.timezone
$$;

create or replace function public.mvl_push_targets(p_users uuid[])
returns table (id uuid, owner_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = ''
as $$ select s.id, s.user_id, s.endpoint, s.p256dh, s.auth from public.mvl_push_subscriptions s where s.user_id = any (p_users) $$;

create or replace function public.mvl_push_record_result(p_subscription uuid, p_ok boolean, p_gone boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_gone then
    delete from public.mvl_push_subscriptions where id = p_subscription;
  elsif p_ok then
    update public.mvl_push_subscriptions set last_success_at = now(), failure_count = 0 where id = p_subscription;
  else
    update public.mvl_push_subscriptions set failure_count = failure_count + 1 where id = p_subscription;
    delete from public.mvl_push_subscriptions where id = p_subscription and failure_count >= 20;
  end if;
end;
$$;

revoke all on function public.mvl_push_subscribe(text, text, text, text) from public, anon;
revoke all on function public.mvl_push_unsubscribe(text) from public, anon;
grant execute on function public.mvl_push_subscribe(text, text, text, text) to authenticated;
grant execute on function public.mvl_push_unsubscribe(text) to authenticated;
revoke all on function public.mvl_push_claim_due(integer) from public, anon, authenticated;
revoke all on function public.mvl_push_targets(uuid[]) from public, anon, authenticated;
revoke all on function public.mvl_push_record_result(uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.mvl_push_claim_due(integer) to service_role;
grant execute on function public.mvl_push_targets(uuid[]) to service_role;
grant execute on function public.mvl_push_record_result(uuid, boolean, boolean) to service_role;
