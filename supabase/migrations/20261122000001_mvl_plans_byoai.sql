-- =====================================================================
-- My Voice Life — Free / Plus / Pro plans + Bring Your Own AI (additive, re-runnable)
-- ---------------------------------------------------------------------
-- Owner decision (2026-11-21): Freemium + BYOAI. No plan includes AI credits for users; voice
-- works with the user's OWN OpenAI key, billed to them by OpenAI. Plans differ by platform limits.
--
--   1. Plans become free / plus / pro (was free / premium). Rows still on 'premium' become 'plus'
--      (0 such rows on the live project when this was written; the pre-flight reports the count).
--   2. Configurable per-plan caps (table, not code): active reminders, upcoming events, AI
--      connections, BYOAI captures per hour/day, BYOAI max recording length. NULL = no cap.
--   3. Caps enforced by triggers on reminders/events (existing rows are never touched).
--   4. Payment grace: a past_due subscription keeps its plan for billing_grace_days (default 7)
--      after the period end, while Stripe retries the card. unpaid/canceled = free, as before.
--   5. mvl_billing_apply_subscription_v2: the webhook passes the plan it derived from the price
--      allow-list (never from the browser). v1 (always 'premium') is dropped.
--   6. BYOAI key storage in Supabase Vault (encrypted at rest). Only service-role functions can
--      store or read a key; users can see only a 4-character hint and the status of their own.
--   7. BYOAI usage + rate limits in a SEPARATE table: platform AI budgets are untouched.
--      byoai_mode (off / admins_only / everyone) defaults to admins_only.
-- Platform-paid AI (the existing mvl_ai_usage path, budgets, kill switch) is unchanged and stays
-- for staff testing only (ai_mode = admins_only).
-- =====================================================================

do $$ begin
  if to_regprocedure('public.mvl_billing_link_customer(uuid,text)') is null then
    raise exception 'MVL pre-flight: apply 20261120000001_mvl_stripe_billing.sql first.';
  end if;
  if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'MVL pre-flight: Supabase Vault (extension supabase_vault) is required.';
  end if;
  raise notice 'MVL pre-flight: % subscription row(s) on the legacy premium plan will become plus.',
    (select count(*) from public.subscriptions where plan = 'premium');
end $$;

-- ---------------------------------------------------------------------
-- 1. Plans: free / plus / pro
-- ---------------------------------------------------------------------
-- Drop the old plan CHECKs (whatever their generated names), move legacy rows, add the new CHECKs.
do $$
declare r record;
begin
  for r in select conrelid::regclass as tbl, conname from pg_constraint
           where contype = 'c' and conrelid in ('public.subscriptions'::regclass, 'public.mvl_plan_limits'::regclass)
             and pg_get_constraintdef(oid) like '%premium%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

update public.subscriptions set plan = 'plus' where plan = 'premium';

alter table public.mvl_plan_limits add column if not exists max_active_reminders integer check (max_active_reminders is null or max_active_reminders > 0);
alter table public.mvl_plan_limits add column if not exists max_upcoming_events integer check (max_upcoming_events is null or max_upcoming_events > 0);
alter table public.mvl_plan_limits add column if not exists max_ai_connections integer not null default 1 check (max_ai_connections between 0 and 10);
-- BYOAI uses the user's own key, but our servers still do the work: never unlimited.
alter table public.mvl_plan_limits add column if not exists byoai_captures_per_hour integer not null default 5 check (byoai_captures_per_hour > 0);
alter table public.mvl_plan_limits add column if not exists byoai_captures_per_day integer not null default 10 check (byoai_captures_per_day > 0);
alter table public.mvl_plan_limits add column if not exists byoai_max_capture_seconds integer not null default 120 check (byoai_max_capture_seconds between 10 and 600);

insert into public.mvl_plan_limits (plan, ai_captures_per_month, audio_minutes_per_month, max_capture_seconds, captures_per_hour, captures_per_day)
select p, l.ai_captures_per_month, l.audio_minutes_per_month, l.max_capture_seconds, l.captures_per_hour, l.captures_per_day
from unnest(array['plus', 'pro']) p
cross join lateral (select * from public.mvl_plan_limits where plan in ('premium', 'free') order by plan = 'premium' desc limit 1) l
on conflict (plan) do nothing;

-- Defaults (configurable afterwards with mvl_admin_update_plan_caps). Applied only to rows that
-- still have the column defaults, so a re-run never overwrites values an admin has changed.
update public.mvl_plan_limits set max_active_reminders = 10, max_upcoming_events = 20, max_ai_connections = 1,
  byoai_captures_per_hour = 5, byoai_captures_per_day = 10, byoai_max_capture_seconds = 120
where plan = 'free' and max_active_reminders is null and max_upcoming_events is null;
update public.mvl_plan_limits set max_ai_connections = 1,
  byoai_captures_per_hour = 20, byoai_captures_per_day = 60, byoai_max_capture_seconds = 300
where plan = 'plus' and byoai_captures_per_day = 10;
update public.mvl_plan_limits set max_ai_connections = 1,
  byoai_captures_per_hour = 40, byoai_captures_per_day = 200, byoai_max_capture_seconds = 600
where plan = 'pro' and byoai_captures_per_day = 10;

-- Finance estimates only (real prices come from Stripe). Proposed, not final: owner can change.
delete from public.mvl_plan_prices where plan = 'premium';
insert into public.mvl_plan_prices (plan, billing_interval, amount_cents, currency, active_from)
values ('plus', 'month', 499, 'USD', '2026-01-01'), ('pro', 'month', 999, 'USD', '2026-01-01')
on conflict do nothing;
delete from public.mvl_plan_limits where plan = 'premium';

do $$ begin
  alter table public.subscriptions add constraint mvl_subscriptions_plan_chk check (plan in ('free', 'plus', 'pro'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.mvl_plan_limits add constraint mvl_plan_limits_plan_chk check (plan in ('free', 'plus', 'pro'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2. Settings: BYOAI switch and payment grace period
-- ---------------------------------------------------------------------
alter table public.mvl_app_settings add column if not exists byoai_mode text not null default 'admins_only'
  check (byoai_mode in ('off', 'admins_only', 'everyone'));
alter table public.mvl_app_settings add column if not exists billing_grace_days integer not null default 7
  check (billing_grace_days between 0 and 30);

-- ---------------------------------------------------------------------
-- 3. Entitlement: paid plan while active/trialing within the period, or past_due within the grace
-- ---------------------------------------------------------------------
create or replace function public.effective_plan(p_user uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select s.plan from public.subscriptions s
    left join public.mvl_app_settings a on a.id
    where s.user_id = p_user
      and (
        (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status = 'past_due' and s.current_period_end is not null
            and s.current_period_end + make_interval(days => coalesce(a.billing_grace_days, 0)) > now())
      )
  ), 'free');
$$;
revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Caps on reminders and events (count only what is active/upcoming; never delete anything)
-- ---------------------------------------------------------------------
create or replace function public.mvl_enforce_reminder_cap()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_limit integer; v_count integer;
begin
  if new.status <> 'scheduled' or (tg_op = 'UPDATE' and old.status = 'scheduled') then return new; end if;
  select l.max_active_reminders into v_limit from public.mvl_plan_limits l where l.plan = public.effective_plan(new.user_id);
  if v_limit is null then return new; end if;
  -- Serialise per user so two simultaneous inserts can't both pass the check.
  perform pg_advisory_xact_lock(hashtext('mvl_reminder_cap'), hashtext(new.user_id::text));
  select count(*) into v_count from public.reminders where user_id = new.user_id and status = 'scheduled' and id <> new.id;
  if v_count >= v_limit then
    raise exception 'PLAN_LIMIT_REMINDERS: % active reminders on your plan', v_limit using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists mvl_reminders_cap on public.reminders;
create trigger mvl_reminders_cap before insert or update of status on public.reminders
  for each row execute function public.mvl_enforce_reminder_cap();

create or replace function public.mvl_enforce_event_cap()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_limit integer; v_count integer;
begin
  if new.starts_at <= now() or (tg_op = 'UPDATE' and old.starts_at > now()) then return new; end if;
  select l.max_upcoming_events into v_limit from public.mvl_plan_limits l where l.plan = public.effective_plan(new.user_id);
  if v_limit is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('mvl_event_cap'), hashtext(new.user_id::text));
  select count(*) into v_count from public.events where user_id = new.user_id and starts_at > now() and id <> new.id;
  if v_count >= v_limit then
    raise exception 'PLAN_LIMIT_EVENTS: % upcoming events on your plan', v_limit using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists mvl_events_cap on public.events;
create trigger mvl_events_cap before insert or update of starts_at on public.events
  for each row execute function public.mvl_enforce_event_cap();

-- ---------------------------------------------------------------------
-- 5. Webhook apply, v2: the plan comes from the server's price allow-list
-- ---------------------------------------------------------------------
drop function if exists public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid);

create or replace function public.mvl_billing_apply_subscription_v2(
  p_event_id text, p_event_type text, p_event_created timestamptz, p_livemode boolean,
  p_customer text, p_subscription text, p_status text, p_price_id text, p_interval text,
  p_period_end timestamptz, p_cancel_at_period_end boolean, p_metadata_user uuid, p_plan text)
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
  if p_status not in ('canceled', 'incomplete_expired') and (p_plan is null or p_plan not in ('plus', 'pro')) then
    raise exception 'a paid plan (plus or pro) is required for status %', p_status;
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
    v_outcome := 'unlinked';
  elsif p_metadata_user is not null and p_metadata_user <> v_user then
    v_outcome := 'user_mismatch';
  else
    select * into s from public.subscriptions where user_id = v_user for update;
    if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription
       and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')
       and p_status in ('canceled', 'incomplete_expired', 'incomplete') then
      v_outcome := 'ignored_other_subscription';
    else
      v_outcome := 'applied';
      v_plan := case when p_status in ('canceled', 'incomplete_expired') then 'free' else p_plan end;
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

-- ---------------------------------------------------------------------
-- 6. BYOAI: users' own provider keys, in Supabase Vault
-- ---------------------------------------------------------------------
create table if not exists public.mvl_ai_connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('openai')),
  vault_secret_id uuid not null unique,
  key_hint text not null check (key_hint ~ '^[A-Za-z0-9_-]{4}$'),
  status text not null default 'active' check (status in ('active', 'invalid')),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.mvl_ai_connections enable row level security;
drop policy if exists "mvl_ai_connections: owner can read" on public.mvl_ai_connections;
create policy "mvl_ai_connections: owner can read" on public.mvl_ai_connections
  for select to authenticated using ((select auth.uid()) = user_id);
-- No client writes. Clients may read every column EXCEPT the Vault secret id.
revoke all on public.mvl_ai_connections from public, anon, authenticated;
grant select (user_id, provider, key_hint, status, validated_at, created_at, updated_at) on public.mvl_ai_connections to authenticated;

-- Whenever a connection row goes (disconnect, account deletion cascade), its Vault secret goes too.
create or replace function public.mvl_ai_connection_drop_secret()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;
drop trigger if exists mvl_ai_connections_drop_secret on public.mvl_ai_connections;
create trigger mvl_ai_connections_drop_secret after delete on public.mvl_ai_connections
  for each row execute function public.mvl_ai_connection_drop_secret();

-- Store (or replace) a user's key. Called ONLY by the ai-connections Edge Function, after it has
-- validated the key with the provider. The key is never returned by any client-reachable function.
create or replace function public.mvl_byoai_set_key(p_user uuid, p_provider text, p_key text, p_hint text)
returns void language plpgsql security definer set search_path = ''
as $$
declare c public.mvl_ai_connections; v_id uuid; v_max integer; v_count integer;
begin
  if p_user is null or p_provider is distinct from 'openai' or p_key is null
     or char_length(p_key) not between 20 and 400 or p_key ~ '\s' or p_hint !~ '^[A-Za-z0-9_-]{4}$' then
    raise exception 'invalid key';
  end if;
  perform pg_advisory_xact_lock(hashtext('mvl_byoai'), hashtext(p_user::text));
  select * into c from public.mvl_ai_connections where user_id = p_user and provider = p_provider for update;
  if found then
    perform vault.update_secret(c.vault_secret_id, p_key);
    update public.mvl_ai_connections set key_hint = p_hint, status = 'active', validated_at = now(), updated_at = now()
     where user_id = p_user and provider = p_provider;
    return;
  end if;
  select l.max_ai_connections into v_max from public.mvl_plan_limits l where l.plan = public.effective_plan(p_user);
  select count(*) into v_count from public.mvl_ai_connections where user_id = p_user;
  if v_count >= coalesce(v_max, 0) then
    raise exception 'PLAN_LIMIT_AI_CONNECTIONS: % AI connection(s) on your plan', coalesce(v_max, 0) using errcode = 'P0001';
  end if;
  v_id := vault.create_secret(p_key, 'mvl_byoai_' || p_user::text || '_' || p_provider, 'My Voice Life: user-provided AI key');
  insert into public.mvl_ai_connections (user_id, provider, vault_secret_id, key_hint, status, validated_at)
  values (p_user, p_provider, v_id, p_hint, 'active', now());
end;
$$;

create or replace function public.mvl_byoai_get_key(p_user uuid, p_provider text)
returns text language sql stable security definer set search_path = ''
as $$
  select d.decrypted_secret from public.mvl_ai_connections c
  join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.user_id = p_user and c.provider = p_provider and c.status = 'active'
$$;

create or replace function public.mvl_byoai_delete_key(p_user uuid, p_provider text)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.mvl_ai_connections where user_id = p_user and provider = p_provider;
  return found;
end;
$$;

create or replace function public.mvl_byoai_mark_invalid(p_user uuid, p_provider text)
returns void language sql security definer set search_path = ''
as $$
  update public.mvl_ai_connections set status = 'invalid', updated_at = now() where user_id = p_user and provider = p_provider
$$;

-- ---------------------------------------------------------------------
-- 7. BYOAI usage and rate limits (separate from platform-paid mvl_ai_usage and its budgets)
-- ---------------------------------------------------------------------
create table if not exists public.mvl_byoai_usage (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL on account deletion: counts stay (anonymised) for platform capacity planning.
  user_id uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  finished_at timestamptz,
  plan text not null,
  provider text not null default 'openai',
  source text not null check (source in ('voice', 'text')),
  status text not null check (status in ('reserved', 'ok', 'failed', 'expired', 'refused')),
  refusal_reason text,
  error_code text,
  audio_seconds numeric(8, 2) not null default 0 check (audio_seconds >= 0),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0
);
create index if not exists mvl_byoai_usage_user_time_idx on public.mvl_byoai_usage (user_id, occurred_at desc);
alter table public.mvl_byoai_usage enable row level security;
drop policy if exists "mvl_byoai_usage: owner can read" on public.mvl_byoai_usage;
create policy "mvl_byoai_usage: owner can read" on public.mvl_byoai_usage
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.mvl_byoai_usage from public, anon, authenticated;
grant select on public.mvl_byoai_usage to authenticated;

create or replace function public.mvl_reserve_byoai_capture(p_user uuid, p_source text, p_audio_seconds numeric)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  s public.mvl_app_settings;
  lim public.mvl_plan_limits;
  v_plan text; v_role text; v_hour integer; v_today integer; v_reason text; v_id uuid; v_connected boolean;
begin
  if p_user is null or p_source not in ('voice', 'text') or p_audio_seconds is null or p_audio_seconds < 0 then
    raise exception 'invalid reservation request';
  end if;
  -- Per-user serialisation: simultaneous requests can't both slip under a limit.
  perform pg_advisory_xact_lock(hashtext('mvl_byoai_usage'), hashtext(p_user::text));
  select * into s from public.mvl_app_settings where id;

  update public.mvl_byoai_usage set status = 'expired', finished_at = now(), error_code = 'reservation_timeout'
   where user_id = p_user and status = 'reserved' and occurred_at < now() - make_interval(mins => s.reservation_timeout_minutes);

  v_plan := public.effective_plan(p_user);
  v_role := public.mvl_staff_role(p_user);
  select * into lim from public.mvl_plan_limits where plan = v_plan;
  select exists (select 1 from public.mvl_ai_connections where user_id = p_user and status = 'active') into v_connected;
  select count(*) filter (where status <> 'refused' and occurred_at >= now() - interval '1 hour'),
         count(*) filter (where status <> 'refused' and occurred_at >= date_trunc('day', now()))
    into v_hour, v_today
    from public.mvl_byoai_usage where user_id = p_user and occurred_at >= least(date_trunc('day', now()), now() - interval '1 hour');

  v_reason := case
    when s.ai_mode = 'off' then 'ai_paused'
    when s.byoai_mode = 'off' then 'byoai_off'
    when s.byoai_mode = 'admins_only' and v_role is null then 'ai_test_mode'
    when lim.plan is null then 'plan_unknown'
    when not v_connected then 'ai_key_required'
    when p_audio_seconds > lim.byoai_max_capture_seconds + 2 then 'audio_too_long'
    when v_hour >= lim.byoai_captures_per_hour then 'rate_limited_hour'
    when v_today >= lim.byoai_captures_per_day then 'rate_limited_day'
  end;

  if v_reason is not null then
    insert into public.mvl_byoai_usage (user_id, plan, source, status, refusal_reason, audio_seconds, finished_at)
    values (p_user, coalesce(v_plan, 'free'), p_source, 'refused', v_reason, 0, now());
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  insert into public.mvl_byoai_usage (user_id, plan, source, status, audio_seconds)
  values (p_user, v_plan, p_source, 'reserved', p_audio_seconds)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'reservation_id', v_id, 'plan', v_plan);
end;
$$;

create or replace function public.mvl_record_byoai_call(p_reservation uuid, p_audio_seconds numeric, p_input_tokens integer, p_output_tokens integer)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(p_audio_seconds, 0) < 0 or coalesce(p_input_tokens, 0) < 0 or coalesce(p_output_tokens, 0) < 0 then
    raise exception 'invalid usage';
  end if;
  update public.mvl_byoai_usage set
    audio_seconds = greatest(audio_seconds, coalesce(p_audio_seconds, 0)),
    input_tokens = input_tokens + coalesce(p_input_tokens, 0),
    output_tokens = output_tokens + coalesce(p_output_tokens, 0)
  where id = p_reservation and status = 'reserved';
  if not found then raise exception 'reservation not open'; end if;
end;
$$;

create or replace function public.mvl_finish_byoai_capture(p_reservation uuid, p_status text, p_error_code text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_status not in ('ok', 'failed') then raise exception 'invalid status'; end if;
  update public.mvl_byoai_usage set status = p_status, error_code = p_error_code, finished_at = now()
  where id = p_reservation and status = 'reserved';
end;
$$;

-- ---------------------------------------------------------------------
-- 8. What the app shows the user (own data only)
-- ---------------------------------------------------------------------
create or replace function public.mvl_my_usage()
returns jsonb language sql stable security definer set search_path = ''
as $$
  with me as (select (select auth.uid()) as uid),
  plan as (select public.effective_plan(me.uid) as plan, public.mvl_staff_role(me.uid) as role from me),
  lim as (select l.* from public.mvl_plan_limits l, plan where l.plan = plan.plan),
  used as (
    select count(*) filter (where status in ('reserved', 'ok', 'expired')) as captures,
           coalesce(sum(audio_seconds) filter (where status in ('reserved', 'ok', 'expired')), 0) as seconds
    from public.mvl_ai_usage, me
    where user_id = me.uid and occurred_at >= date_trunc('month', now())
  ),
  byoai as (
    select count(*) filter (where status <> 'refused' and occurred_at >= date_trunc('day', now())) as today
    from public.mvl_byoai_usage, me where user_id = me.uid and occurred_at >= date_trunc('day', now())
  ),
  conn as (
    select bool_or(status = 'active') as connected, bool_or(status = 'invalid') as invalid
    from public.mvl_ai_connections, me where user_id = me.uid
  ),
  counts as (
    select (select count(*) from public.reminders r, me where r.user_id = me.uid and r.status = 'scheduled') as reminders,
           (select count(*) from public.events e, me where e.user_id = me.uid and e.starts_at > now()) as events
  )
  select jsonb_build_object(
    'plan', plan.plan,
    'is_staff', plan.role is not null,
    'is_admin', plan.role = 'admin',
    'ai_mode', s.ai_mode,
    -- Platform-paid AI (staff testing only while ai_mode = admins_only).
    'ai_available', s.ai_mode = 'on' or (s.ai_mode = 'admins_only' and plan.role is not null),
    'ai_paused_message', s.ai_paused_message,
    'captures_used', used.captures, 'captures_limit', lim.ai_captures_per_month,
    'minutes_used', round(used.seconds / 60.0, 1), 'minutes_limit', lim.audio_minutes_per_month,
    'max_capture_seconds', lim.max_capture_seconds,
    'resets_at', date_trunc('month', now()) + interval '1 month',
    -- Bring Your Own AI.
    'byoai_mode', s.byoai_mode,
    'byoai_allowed', s.ai_mode <> 'off' and (s.byoai_mode = 'everyone' or (s.byoai_mode = 'admins_only' and plan.role is not null)),
    'byoai_connected', coalesce(conn.connected, false),
    'byoai_key_invalid', coalesce(conn.invalid, false) and not coalesce(conn.connected, false),
    'byoai_used_today', byoai.today,
    'byoai_captures_per_day', lim.byoai_captures_per_day,
    'byoai_max_capture_seconds', lim.byoai_max_capture_seconds,
    -- Plan caps (null = no cap) and current counts.
    'max_active_reminders', lim.max_active_reminders, 'active_reminders', counts.reminders,
    'max_upcoming_events', lim.max_upcoming_events, 'upcoming_events', counts.events,
    'max_ai_connections', lim.max_ai_connections
  )
  from me, plan, lim, used, byoai, conn, counts, public.mvl_app_settings s
  where me.uid is not null
$$;

-- ---------------------------------------------------------------------
-- 9. Admin: caps, BYOAI switch, grace period, finance estimates for plus/pro
-- ---------------------------------------------------------------------
create or replace function public.mvl_admin_update_plan_caps(
  p_plan text, p_max_reminders integer, p_max_events integer, p_max_connections integer,
  p_byoai_per_hour integer, p_byoai_per_day integer, p_byoai_max_seconds integer
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  update public.mvl_plan_limits set
    max_active_reminders = p_max_reminders, max_upcoming_events = p_max_events, max_ai_connections = p_max_connections,
    byoai_captures_per_hour = p_byoai_per_hour, byoai_captures_per_day = p_byoai_per_day,
    byoai_max_capture_seconds = p_byoai_max_seconds, updated_at = now()
  where plan = p_plan;
  if not found then raise exception 'unknown plan %', p_plan; end if;
end;
$$;

create or replace function public.mvl_admin_update_billing_settings(p_byoai_mode text default null, p_billing_grace_days integer default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  update public.mvl_app_settings set
    byoai_mode = coalesce(p_byoai_mode, byoai_mode),
    billing_grace_days = coalesce(p_billing_grace_days, billing_grace_days),
    updated_at = now(), updated_by = (select auth.uid())
  where id;
end;
$$;

create or replace function public.mvl_admin_finance_summary(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  m date := date_trunc('month', coalesce(p_month, current_date))::date;
  s public.mvl_app_settings; f public.mvl_fee_schedules;
  pr record;
  n_users integer; n_plus integer; n_pro integer; n_mau integer;
  price_plus numeric := 0; price_pro numeric := 0;
  gross numeric; net numeric; fees numeric; ai_usd numeric; opex_eur numeric; opex_actual_eur numeric;
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into s from public.mvl_app_settings;
  select * into f from public.mvl_fee_schedules where provider = 'stripe' and card_region = s.fee_card_region
    and effective_from <= (m + interval '1 month')::date order by effective_from desc limit 1;
  -- Monthly list prices, converted to EUR when stored in USD.
  for pr in select distinct on (plan) plan, amount_cents, currency from public.mvl_plan_prices
            where billing_interval = 'month' and active_from <= m + interval '1 month' and (active_to is null or active_to > m)
            order by plan, active_from desc loop
    if pr.plan = 'plus' then price_plus := pr.amount_cents / 100.0 * case pr.currency when 'USD' then s.fx_usd_to_eur else 1 end; end if;
    if pr.plan = 'pro' then price_pro := pr.amount_cents / 100.0 * case pr.currency when 'USD' then s.fx_usd_to_eur else 1 end; end if;
  end loop;

  select count(*) into n_users from auth.users;
  select count(*) filter (where public.effective_plan(user_id) = 'plus'), count(*) filter (where public.effective_plan(user_id) = 'pro')
    into n_plus, n_pro from public.subscriptions;
  select count(distinct user_id) into n_mau from public.mvl_daily_activity where day >= m and day < (m + interval '1 month')::date;

  gross := n_plus * price_plus + n_pro * price_pro;
  net := case when s.prices_include_vat then gross / (1 + s.vat_rate) else gross end;
  fees := n_plus * (price_plus * (coalesce(f.pct, 0) + coalesce(f.billing_pct, 0)) + coalesce(f.fixed_cents, 0) / 100.0)
        + n_pro * (price_pro * (coalesce(f.pct, 0) + coalesce(f.billing_pct, 0)) + coalesce(f.fixed_cents, 0) / 100.0);
  select coalesce(sum(est_cost_usd), 0) into ai_usd from public.mvl_ai_usage where occurred_at >= m and occurred_at < m + interval '1 month';
  select coalesce(sum(case currency when 'USD' then amount * s.fx_usd_to_eur else amount end), 0),
         coalesce(sum(case currency when 'USD' then amount * s.fx_usd_to_eur else amount end) filter (where kind = 'actual'), 0)
    into opex_eur, opex_actual_eur
    from public.mvl_operating_expenses where month = m;

  return jsonb_build_object(
    'month', m,
    'currency', 'EUR',
    'payments_active', false,
    'labels', jsonb_build_object(
      'revenue', 'PROJECTED at monthly list prices (converted to EUR); no live payments are active.',
      'net_revenue', 'ESTIMATE: revenue minus VAT using the configured VAT rate.',
      'stripe_fees', 'ESTIMATE from the configured fee schedule; Stripe is not active.',
      'ai_costs', 'ESTIMATE of platform-paid AI only (staff testing). BYOAI usage is paid by users to their provider.',
      'operating_expenses', 'Entered by admin; each row marked actual or estimate.',
      'contribution', 'ESTIMATE, NOT PROFIT: excludes income tax, refunds, chargebacks, salaries and your own time.'),
    'users', jsonb_build_object('total', n_users, 'monthly_active', n_mau,
      'paid', n_plus + n_pro, 'plus', n_plus, 'pro', n_pro, 'free', n_users - n_plus - n_pro),
    'revenue_gross_eur', round(gross, 2),
    'revenue_net_eur', round(net, 2),
    'stripe_fees_eur', round(fees, 2),
    'ai_costs_usd', round(ai_usd, 4),
    'ai_costs_eur', round(ai_usd * s.fx_usd_to_eur, 2),
    'operating_expenses_eur', round(opex_eur, 2),
    'operating_expenses_actual_eur', round(opex_actual_eur, 2),
    'estimated_contribution_eur', round(net - fees - ai_usd * s.fx_usd_to_eur - opex_eur, 2),
    'assumptions', jsonb_build_object('fx_usd_to_eur', s.fx_usd_to_eur, 'vat_rate', s.vat_rate,
      'prices_include_vat', s.prices_include_vat, 'fee_region', s.fee_card_region,
      'price_plus_monthly_eur', round(price_plus, 2), 'price_pro_monthly_eur', round(price_pro, 2)),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) - 'created_by' order by e.category, e.service)
                          from public.mvl_operating_expenses e where e.month = m), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 10. Privileges: lock everything down, then grant precisely
-- ---------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'effective_plan(uuid)', 'mvl_enforce_reminder_cap()', 'mvl_enforce_event_cap()',
    'mvl_billing_apply_subscription_v2(text,text,timestamptz,boolean,text,text,text,text,text,timestamptz,boolean,uuid,text)',
    'mvl_ai_connection_drop_secret()',
    'mvl_byoai_set_key(uuid,text,text,text)', 'mvl_byoai_get_key(uuid,text)', 'mvl_byoai_delete_key(uuid,text)',
    'mvl_byoai_mark_invalid(uuid,text)',
    'mvl_reserve_byoai_capture(uuid,text,numeric)', 'mvl_record_byoai_call(uuid,numeric,integer,integer)',
    'mvl_finish_byoai_capture(uuid,text,text)',
    'mvl_my_usage()', 'mvl_admin_update_plan_caps(text,integer,integer,integer,integer,integer,integer)',
    'mvl_admin_update_billing_settings(text,integer)', 'mvl_admin_finance_summary(date)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
  end loop;
end $$;

-- Edge Functions (service role) only.
grant execute on function public.mvl_billing_apply_subscription_v2(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid, text) to service_role;
grant execute on function public.mvl_byoai_set_key(uuid, text, text, text) to service_role;
grant execute on function public.mvl_byoai_get_key(uuid, text) to service_role;
grant execute on function public.mvl_byoai_delete_key(uuid, text) to service_role;
grant execute on function public.mvl_byoai_mark_invalid(uuid, text) to service_role;
grant execute on function public.mvl_reserve_byoai_capture(uuid, text, numeric) to service_role;
grant execute on function public.mvl_record_byoai_call(uuid, numeric, integer, integer) to service_role;
grant execute on function public.mvl_finish_byoai_capture(uuid, text, text) to service_role;

-- Signed-in users: own usage; admin RPCs check mvl_is_admin() inside.
grant execute on function public.mvl_my_usage() to authenticated;
grant execute on function public.mvl_admin_update_plan_caps(text, integer, integer, integer, integer, integer, integer) to authenticated;
grant execute on function public.mvl_admin_update_billing_settings(text, integer) to authenticated;
grant execute on function public.mvl_admin_finance_summary(date) to authenticated;
