-- =====================================================================
-- My Voice Life — financial controls (AI usage ledger, allowances,
-- rate limits, budgets, kill switch, admin finance data)
-- ---------------------------------------------------------------------
-- Additive except one approved behaviour change: the free-plan limit moves
-- from "7 saved notes" to "7 AI voice captures"; manual notes become unlimited
-- (the notes quota trigger is removed).
-- Money/usage tables are written ONLY by SECURITY DEFINER functions that the
-- Edge Function calls with the service role. Users can never insert, update
-- or delete them, so deleting a note or session never restores an allowance.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Approved behaviour change: manual notes are unlimited
-- ---------------------------------------------------------------------
drop trigger if exists notes_enforce_quota on public.notes;
drop function if exists public.enforce_note_quota();
drop function if exists public.plan_limits(text);
-- public.usage_counters is kept (historical rows) but no longer used.

-- ---------------------------------------------------------------------
-- 1. Settings (single row) and staff
-- ---------------------------------------------------------------------
create table if not exists public.mvl_app_settings (
  id boolean primary key default true check (id),
  -- 'admins_only' = only staff (admins + testers) may use AI. Default until
  -- privacy review and paid-tier billing are approved by the owner.
  ai_mode text not null default 'admins_only' check (ai_mode in ('on', 'admins_only', 'off')),
  ai_paused_message text check (ai_paused_message is null or char_length(ai_paused_message) <= 300),
  daily_ai_budget_usd numeric(10, 2) not null default 2.00 check (daily_ai_budget_usd >= 0),
  monthly_ai_budget_usd numeric(10, 2) not null default 20.00 check (monthly_ai_budget_usd >= 0),
  alert_thresholds numeric[] not null default '{0.5,0.8,1.0}',
  -- Caps used both to configure Gemini calls and to compute worst-case cost.
  max_output_tokens_per_call integer not null default 2048 check (max_output_tokens_per_call between 256 and 8192),
  max_text_in_tokens_per_capture integer not null default 6500 check (max_text_in_tokens_per_capture between 500 and 20000),
  disable_thinking boolean not null default true,
  reservation_timeout_minutes integer not null default 15 check (reservation_timeout_minutes between 2 and 120),
  -- Finance estimates (labelled as such in reports)
  fx_usd_to_eur numeric(10, 4) not null default 0.90 check (fx_usd_to_eur > 0),
  vat_rate numeric(5, 4) not null default 0 check (vat_rate between 0 and 0.5),
  prices_include_vat boolean not null default true,
  fee_card_region text not null default 'eea',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.mvl_app_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.mvl_staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'tester')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Plans, prices, fees, AI prices (configurable without code changes)
-- ---------------------------------------------------------------------
create table if not exists public.mvl_plan_limits (
  plan text primary key check (plan in ('free', 'premium')),
  -- NOT NULL + > 0: no plan can be unlimited.
  ai_captures_per_month integer not null check (ai_captures_per_month > 0),
  audio_minutes_per_month integer not null check (audio_minutes_per_month > 0),
  max_capture_seconds integer not null check (max_capture_seconds between 10 and 600),
  captures_per_hour integer not null check (captures_per_hour > 0),
  captures_per_day integer not null check (captures_per_day > 0),
  updated_at timestamptz not null default now()
);
-- Seed rows. Skipped once migration 6 (free/plus/pro) has run, so re-running this file never
-- re-creates the retired 'premium' plan. No effect on a database that already applied this file.
insert into public.mvl_plan_limits (plan, ai_captures_per_month, audio_minutes_per_month, max_capture_seconds, captures_per_hour, captures_per_day)
select * from (values ('free', 7, 15, 120, 5, 7), ('premium', 300, 600, 300, 30, 60)) v
where not exists (select 1 from public.mvl_plan_limits where plan = 'plus')
on conflict (plan) do nothing;

create table if not exists public.mvl_plan_prices (
  id bigserial primary key,
  plan text not null references public.mvl_plan_limits (plan),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  active_from date not null,
  active_to date,
  unique (plan, billing_interval, active_from)
);
insert into public.mvl_plan_prices (plan, billing_interval, amount_cents, currency, active_from)
select * from (values ('premium', 'month', 499, 'EUR', '2026-01-01'::date), ('premium', 'year', 3999, 'EUR', '2026-01-01'::date)) v
where not exists (select 1 from public.mvl_plan_limits where plan = 'plus')
on conflict do nothing;

create table if not exists public.mvl_fee_schedules (
  id bigserial primary key,
  provider text not null,
  card_region text not null,
  pct numeric(6, 4) not null check (pct >= 0),
  fixed_cents integer not null check (fixed_cents >= 0),
  billing_pct numeric(6, 4) not null default 0 check (billing_pct >= 0),
  currency text not null default 'EUR',
  effective_from date not null,
  source_url text,
  unique (provider, card_region, effective_from)
);
insert into public.mvl_fee_schedules (provider, card_region, pct, fixed_cents, billing_pct, currency, effective_from, source_url)
values ('stripe', 'eea', 0.0150, 25, 0.0070, 'EUR', '2026-11-18', 'https://stripe.com/ie/pricing'),
       ('stripe', 'international', 0.0315, 25, 0.0070, 'EUR', '2026-11-18', 'https://stripe.com/ie/pricing')
on conflict do nothing;

create table if not exists public.mvl_price_book (
  id bigserial primary key,
  provider text not null,
  model text not null,
  audio_in_usd_per_m numeric(10, 4) not null check (audio_in_usd_per_m >= 0),
  text_in_usd_per_m numeric(10, 4) not null check (text_in_usd_per_m >= 0),
  output_usd_per_m numeric(10, 4) not null check (output_usd_per_m >= 0),
  effective_from date not null,
  effective_to date,
  source_url text not null,
  unique (provider, model, effective_from)
);
insert into public.mvl_price_book (provider, model, audio_in_usd_per_m, text_in_usd_per_m, output_usd_per_m, effective_from, source_url)
values ('gemini', 'gemini-2.5-flash', 1.00, 0.30, 2.50, '2026-11-18', 'https://ai.google.dev/gemini-api/docs/pricing'),
       ('gemini', 'gemini-2.5-flash-lite', 0.30, 0.10, 0.40, '2026-11-18', 'https://ai.google.dev/gemini-api/docs/pricing')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. The AI usage ledger: one row per capture (the allowance unit).
--    Contains NO content: no audio, no transcript, no note text.
-- ---------------------------------------------------------------------
create table if not exists public.mvl_ai_usage (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL on account deletion: the cost record stays (anonymised) for accounting.
  user_id uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  finished_at timestamptz,
  plan text not null,
  source text not null check (source in ('voice', 'text')),
  status text not null check (status in ('reserved', 'ok', 'failed', 'expired', 'refused')),
  refusal_reason text,
  provider text,
  model text,
  price_book_id bigint references public.mvl_price_book (id),
  audio_seconds numeric(8, 2) not null default 0 check (audio_seconds >= 0),
  provider_calls integer not null default 0,
  audio_tokens integer not null default 0,
  text_in_tokens integer not null default 0,
  output_tokens integer not null default 0,
  thinking_tokens integer not null default 0,
  reserved_cost_usd numeric(12, 6) not null default 0,  -- worst-case hold while in flight
  est_cost_usd numeric(12, 6) not null default 0,       -- ESTIMATE from recorded tokens x price book
  error_code text
);
create index if not exists mvl_ai_usage_user_time_idx on public.mvl_ai_usage (user_id, occurred_at desc);
create index if not exists mvl_ai_usage_time_idx on public.mvl_ai_usage (occurred_at);
create index if not exists mvl_ai_usage_reserved_idx on public.mvl_ai_usage (occurred_at) where status = 'reserved';

create table if not exists public.mvl_budget_alerts (
  id bigserial primary key,
  period text not null check (period in ('day', 'month')),
  period_start date not null,
  threshold numeric not null,
  spend_usd numeric(12, 4) not null,
  budget_usd numeric(12, 2) not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  unique (period, period_start, threshold)
);

create table if not exists public.mvl_operating_expenses (
  id bigserial primary key,
  month date not null check (extract(day from month) = 1),
  service text not null check (char_length(service) between 1 and 80),
  category text not null check (category in ('hosting', 'database', 'ai', 'payments', 'email', 'domain', 'other')),
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'USD' check (currency in ('USD', 'EUR')),
  kind text not null check (kind in ('actual', 'estimate')),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.mvl_daily_activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------
create or replace function public.mvl_staff_role(p_user uuid)
returns text language sql stable security definer set search_path = ''
as $$ select role from public.mvl_staff where user_id = p_user $$;

create or replace function public.mvl_is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(public.mvl_staff_role((select auth.uid())) = 'admin', false) $$;

create or replace function public.mvl_current_price(p_provider text, p_model text)
returns public.mvl_price_book language sql stable security definer set search_path = ''
as $$
  select * from public.mvl_price_book
  where provider = p_provider and model = p_model
    and effective_from <= current_date and (effective_to is null or effective_to > current_date)
  order by effective_from desc limit 1
$$;

-- Worst-case USD cost of one capture: audio + maximum text in + maximum output
-- of two calls (transcribe + extract). Used to hold budget while in flight.
create or replace function public.mvl_capture_cost_ceiling(p_price public.mvl_price_book, p_audio_seconds numeric)
returns numeric language sql stable security definer set search_path = ''
as $$
  select round((
      ceil(p_audio_seconds * 32) * p_price.audio_in_usd_per_m
    + s.max_text_in_tokens_per_capture * p_price.text_in_usd_per_m
    + 2 * s.max_output_tokens_per_call * p_price.output_usd_per_m
  ) / 1000000.0, 6)
  from public.mvl_app_settings s
$$;

-- Spend that counts against budgets: recorded cost of finished captures plus the
-- worst-case hold of captures still in flight.
create or replace function public.mvl_spend_since(p_since timestamptz)
returns numeric language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(case when status = 'reserved' then greatest(reserved_cost_usd, est_cost_usd) else est_cost_usd end), 0)
  from public.mvl_ai_usage
  where occurred_at >= p_since and status in ('reserved', 'ok', 'failed', 'expired')
$$;

-- Records a threshold alert once per period. Returns true if it is new.
create or replace function public.mvl_maybe_alert(p_period text, p_start date, p_spend numeric, p_budget numeric)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare t numeric; created boolean := false; n integer;
begin
  if p_budget <= 0 then return false; end if;
  foreach t in array (select alert_thresholds from public.mvl_app_settings) loop
    if p_spend >= p_budget * t then
      insert into public.mvl_budget_alerts (period, period_start, threshold, spend_usd, budget_usd)
      values (p_period, p_start, t, p_spend, p_budget)
      on conflict (period, period_start, threshold) do nothing;
      get diagnostics n = row_count;
      created := created or n > 0;
    end if;
  end loop;
  return created;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Reservation: the ONLY way to start an AI capture.
--    Serialised by a row lock on the settings row, so concurrent requests
--    cannot both pass the same remaining allowance or budget.
-- ---------------------------------------------------------------------
create or replace function public.mvl_reserve_ai_capture(
  p_user uuid, p_source text, p_audio_seconds numeric, p_provider text, p_model text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  s public.mvl_app_settings;
  lim public.mvl_plan_limits;
  price public.mvl_price_book;
  v_plan text;
  v_role text;
  v_month timestamptz := date_trunc('month', now());
  v_day timestamptz := date_trunc('day', now());
  v_captures integer; v_seconds numeric; v_hour integer; v_today integer;
  v_ceiling numeric; v_day_spend numeric; v_month_spend numeric;
  v_reason text; v_id uuid; v_alert boolean := false;
begin
  if p_source not in ('voice', 'text') or p_audio_seconds < 0 then
    raise exception 'invalid reservation request';
  end if;

  -- Global serialisation point (also gives a consistent view of settings).
  select * into s from public.mvl_app_settings where id for update;

  -- Expire abandoned reservations (e.g. the function crashed). They keep their
  -- worst-case cost as spend: the provider may have charged for them.
  update public.mvl_ai_usage
     set status = 'expired', est_cost_usd = greatest(est_cost_usd, reserved_cost_usd), finished_at = now(), error_code = 'reservation_timeout'
   where status = 'reserved' and occurred_at < now() - make_interval(mins => s.reservation_timeout_minutes);

  v_plan := public.effective_plan(p_user);
  v_role := public.mvl_staff_role(p_user);
  select * into lim from public.mvl_plan_limits where plan = v_plan;
  price := public.mvl_current_price(p_provider, p_model);

  select count(*) filter (where status in ('reserved', 'ok', 'expired') and occurred_at >= v_month),
         coalesce(sum(audio_seconds) filter (where status in ('reserved', 'ok', 'expired') and occurred_at >= v_month), 0),
         count(*) filter (where status <> 'refused' and occurred_at >= now() - interval '1 hour'),
         count(*) filter (where status <> 'refused' and occurred_at >= v_day)
    into v_captures, v_seconds, v_hour, v_today
    from public.mvl_ai_usage where user_id = p_user and occurred_at >= least(v_month, now() - interval '1 hour');

  v_reason := case
    when s.ai_mode = 'off' then 'ai_paused'
    when s.ai_mode = 'admins_only' and v_role is null then 'ai_test_mode'
    when price.id is null then 'ai_price_unknown'          -- fail closed: no price = no budget control
    when lim.plan is null then 'plan_unknown'
    when p_audio_seconds > lim.max_capture_seconds + 2 then 'audio_too_long'
    when v_captures >= lim.ai_captures_per_month then 'quota_captures'
    when v_seconds + p_audio_seconds > lim.audio_minutes_per_month * 60 then 'quota_minutes'
    when v_hour >= lim.captures_per_hour then 'rate_limited_hour'
    when v_today >= lim.captures_per_day then 'rate_limited_day'
  end;

  if v_reason is null then
    v_ceiling := public.mvl_capture_cost_ceiling(price, p_audio_seconds);
    v_day_spend := public.mvl_spend_since(v_day);
    v_month_spend := public.mvl_spend_since(v_month);
    if v_day_spend + v_ceiling > s.daily_ai_budget_usd then
      v_reason := 'budget_daily';
    elsif v_month_spend + v_ceiling > s.monthly_ai_budget_usd then
      v_reason := 'budget_monthly';
    end if;
  end if;

  if v_reason is not null then
    insert into public.mvl_ai_usage (user_id, plan, source, status, refusal_reason, provider, model, audio_seconds, finished_at)
    values (p_user, coalesce(v_plan, 'free'), p_source, 'refused', v_reason, p_provider, p_model, 0, now());
    if v_reason in ('budget_daily', 'budget_monthly') then
      -- Budget reached: record a 100% alert so the administrator is notified.
      v_alert := public.mvl_maybe_alert(case v_reason when 'budget_daily' then 'day' else 'month' end,
                   (case v_reason when 'budget_daily' then v_day else v_month end)::date,
                   -- spend this request would have reached, so the 100% "budget reached" alert fires
                   case v_reason when 'budget_daily' then v_day_spend else v_month_spend end + v_ceiling,
                   case v_reason when 'budget_daily' then s.daily_ai_budget_usd else s.monthly_ai_budget_usd end);
    end if;
    return jsonb_build_object('ok', false, 'reason', v_reason, 'alert_created', v_alert);
  end if;

  insert into public.mvl_ai_usage (user_id, plan, source, status, provider, model, price_book_id, audio_seconds, reserved_cost_usd)
  values (p_user, v_plan, p_source, 'reserved', p_provider, p_model, price.id, p_audio_seconds, v_ceiling)
  returning id into v_id;

  -- Threshold alerts on the spend including this hold.
  v_alert := public.mvl_maybe_alert('day', v_day::date, v_day_spend + v_ceiling, s.daily_ai_budget_usd);
  v_alert := public.mvl_maybe_alert('month', v_month::date, v_month_spend + v_ceiling, s.monthly_ai_budget_usd) or v_alert;

  return jsonb_build_object(
    'ok', true, 'reservation_id', v_id, 'plan', v_plan, 'alert_created', v_alert,
    'max_output_tokens', s.max_output_tokens_per_call, 'disable_thinking', s.disable_thinking,
    'captures_used', v_captures + 1, 'captures_limit', lim.ai_captures_per_month,
    'minutes_used', round((v_seconds + p_audio_seconds) / 60.0, 1), 'minutes_limit', lim.audio_minutes_per_month
  );
end;
$$;

-- Adds one provider call's recorded token usage to a reservation.
create or replace function public.mvl_record_ai_call(
  p_reservation uuid, p_audio_tokens integer, p_text_in_tokens integer, p_output_tokens integer, p_thinking_tokens integer
) returns numeric language plpgsql security definer set search_path = ''
as $$
declare r public.mvl_ai_usage; p public.mvl_price_book; v_cost numeric;
begin
  if least(p_audio_tokens, p_text_in_tokens, p_output_tokens, p_thinking_tokens) < 0 then
    raise exception 'negative token count';
  end if;
  select * into r from public.mvl_ai_usage where id = p_reservation for update;
  if r.id is null or r.status <> 'reserved' then
    raise exception 'reservation % is not active', p_reservation;
  end if;
  select * into p from public.mvl_price_book where id = r.price_book_id;
  v_cost := (p_audio_tokens * p.audio_in_usd_per_m + p_text_in_tokens * p.text_in_usd_per_m
             + (p_output_tokens + p_thinking_tokens) * p.output_usd_per_m) / 1000000.0;
  update public.mvl_ai_usage set
    provider_calls = provider_calls + 1,
    audio_tokens = audio_tokens + p_audio_tokens,
    text_in_tokens = text_in_tokens + p_text_in_tokens,
    output_tokens = output_tokens + p_output_tokens,
    thinking_tokens = thinking_tokens + p_thinking_tokens,
    est_cost_usd = round(est_cost_usd + v_cost, 6),
    -- Actual audio length from recorded tokens (32 tokens per second).
    audio_seconds = case when p_audio_tokens > 0 then round(p_audio_tokens / 32.0, 2) else audio_seconds end
  where id = p_reservation;
  return round(v_cost, 6);
end;
$$;

-- Closes a reservation as ok or failed. Failed captures keep their recorded cost
-- (budgets stay accurate) but do not use up the monthly allowance.
create or replace function public.mvl_finish_ai_capture(p_reservation uuid, p_status text, p_error_code text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_status not in ('ok', 'failed') then raise exception 'invalid status %', p_status; end if;
  update public.mvl_ai_usage
     set status = p_status, finished_at = now(), error_code = p_error_code
   where id = p_reservation and status = 'reserved';
  if not found then raise exception 'reservation % is not active', p_reservation; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. User-facing RPCs (own data only)
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
  )
  select jsonb_build_object(
    'plan', plan.plan,
    'is_staff', plan.role is not null,
    'is_admin', plan.role = 'admin',
    'ai_mode', s.ai_mode,
    'ai_available', s.ai_mode = 'on' or (s.ai_mode = 'admins_only' and plan.role is not null),
    'ai_paused_message', s.ai_paused_message,
    'captures_used', used.captures, 'captures_limit', lim.ai_captures_per_month,
    'minutes_used', round(used.seconds / 60.0, 1), 'minutes_limit', lim.audio_minutes_per_month,
    'max_capture_seconds', lim.max_capture_seconds,
    'resets_at', date_trunc('month', now()) + interval '1 month'
  )
  from me, plan, lim, used, public.mvl_app_settings s
  where me.uid is not null
$$;

create or replace function public.mvl_touch_activity()
returns void language sql security definer set search_path = ''
as $$
  insert into public.mvl_daily_activity (user_id, day)
  select (select auth.uid()), (now() at time zone 'utc')::date
  where (select auth.uid()) is not null
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------
-- 7. Admin RPCs — aggregates only, never note/transcript content
-- ---------------------------------------------------------------------
create or replace function public.mvl_admin_usage_summary(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare m timestamptz := date_trunc('month', coalesce(p_month, current_date)::timestamptz); s public.mvl_app_settings;
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into s from public.mvl_app_settings;
  return jsonb_build_object(
    'month', m::date,
    'settings', to_jsonb(s) - 'updated_by',
    'spend_today_usd', round(public.mvl_spend_since(date_trunc('day', now())), 4),
    'spend_month_usd', round(public.mvl_spend_since(date_trunc('month', now())), 4),
    'totals', (select jsonb_build_object(
        'captures_ok', count(*) filter (where status = 'ok'),
        'captures_failed', count(*) filter (where status = 'failed'),
        'captures_expired', count(*) filter (where status = 'expired'),
        'captures_in_flight', count(*) filter (where status = 'reserved'),
        'refusals', count(*) filter (where status = 'refused'),
        'audio_minutes', round(coalesce(sum(audio_seconds) filter (where status <> 'refused'), 0) / 60.0, 1),
        'provider_calls', coalesce(sum(provider_calls), 0),
        'audio_tokens', coalesce(sum(audio_tokens), 0), 'text_in_tokens', coalesce(sum(text_in_tokens), 0),
        'output_tokens', coalesce(sum(output_tokens), 0), 'thinking_tokens', coalesce(sum(thinking_tokens), 0),
        'est_cost_usd', round(coalesce(sum(est_cost_usd), 0), 4),
        'active_ai_users', count(distinct user_id) filter (where status <> 'refused'))
      from public.mvl_ai_usage where occurred_at >= m and occurred_at < m + interval '1 month'),
    'refusals_by_reason', coalesce((select jsonb_object_agg(refusal_reason, n) from (
        select refusal_reason, count(*) n from public.mvl_ai_usage
        where status = 'refused' and occurred_at >= m and occurred_at < m + interval '1 month' group by 1) x), '{}'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'captures', c, 'cost_usd', round(cost, 4)) order by d) from (
        select occurred_at::date d, count(*) filter (where status in ('ok', 'failed', 'expired')) c, sum(est_cost_usd) cost
        from public.mvl_ai_usage where occurred_at >= m and occurred_at < m + interval '1 month' group by 1) x), '[]'::jsonb),
    -- Pseudonymous: a short hash, never an email or the raw id.
    'top_users', coalesce((select jsonb_agg(jsonb_build_object('user', left(md5(coalesce(user_id::text, 'deleted')), 8),
                    'plan', plan, 'captures', c, 'audio_minutes', round(sec / 60.0, 1), 'cost_usd', round(cost, 4)) order by cost desc) from (
        select user_id, max(plan) plan, count(*) c, sum(audio_seconds) sec, sum(est_cost_usd) cost
        from public.mvl_ai_usage where status <> 'refused' and occurred_at >= m and occurred_at < m + interval '1 month'
        group by user_id order by sum(est_cost_usd) desc limit 10) x), '[]'::jsonb),
    'plan_limits', (select jsonb_agg(to_jsonb(l) order by l.plan) from public.mvl_plan_limits l),
    'alerts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from (
        select * from public.mvl_budget_alerts order by created_at desc limit 20) a), '[]'::jsonb)
  );
end;
$$;

create or replace function public.mvl_admin_finance_summary(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  m date := date_trunc('month', coalesce(p_month, current_date))::date;
  s public.mvl_app_settings; f public.mvl_fee_schedules;
  price_m numeric; price_y numeric;
  n_users integer; n_premium_m integer; n_premium_y integer; n_mau integer;
  gross numeric; net numeric; fees numeric; ai_usd numeric; opex_eur numeric; opex_actual_eur numeric;
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into s from public.mvl_app_settings;
  select * into f from public.mvl_fee_schedules where provider = 'stripe' and card_region = s.fee_card_region
    and effective_from <= (m + interval '1 month')::date order by effective_from desc limit 1;
  select amount_cents / 100.0 into price_m from public.mvl_plan_prices where plan = 'premium' and billing_interval = 'month'
    and active_from <= m + interval '1 month' and (active_to is null or active_to > m) order by active_from desc limit 1;
  select amount_cents / 100.0 into price_y from public.mvl_plan_prices where plan = 'premium' and billing_interval = 'year'
    and active_from <= m + interval '1 month' and (active_to is null or active_to > m) order by active_from desc limit 1;

  select count(*) into n_users from auth.users;
  select count(*) filter (where coalesce(billing_interval, 'month') = 'month'), count(*) filter (where billing_interval = 'year')
    into n_premium_m, n_premium_y
    from public.subscriptions where public.effective_plan(user_id) = 'premium';
  select count(distinct user_id) into n_mau from public.mvl_daily_activity where day >= m and day < (m + interval '1 month')::date;

  -- Monthly-equivalent revenue at list prices (annual / 12).
  gross := n_premium_m * coalesce(price_m, 0) + n_premium_y * coalesce(price_y, 0) / 12.0;
  net := case when s.prices_include_vat then gross / (1 + s.vat_rate) else gross end;
  fees := n_premium_m * (coalesce(price_m, 0) * (coalesce(f.pct, 0) + coalesce(f.billing_pct, 0)) + coalesce(f.fixed_cents, 0) / 100.0)
        + n_premium_y * (coalesce(price_y, 0) * (coalesce(f.pct, 0) + coalesce(f.billing_pct, 0)) + coalesce(f.fixed_cents, 0) / 100.0) / 12.0;
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
      'revenue', 'PROJECTED at list prices; no payments are active. Monthly-equivalent (annual / 12).',
      'net_revenue', 'ESTIMATE: revenue minus VAT using the configured VAT rate.',
      'stripe_fees', 'ESTIMATE from the configured fee schedule; Stripe is not active.',
      'ai_costs', 'ESTIMATE from recorded token usage x price book; the provider invoice is authoritative.',
      'operating_expenses', 'Entered by admin; each row marked actual or estimate.',
      'contribution', 'ESTIMATE, NOT PROFIT: excludes income tax, refunds, chargebacks, salaries and your own time.'),
    'users', jsonb_build_object('total', n_users, 'monthly_active', n_mau,
      'premium', n_premium_m + n_premium_y, 'premium_monthly', n_premium_m, 'premium_annual', n_premium_y,
      'free', n_users - n_premium_m - n_premium_y),
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
      'price_monthly_eur', price_m, 'price_annual_eur', price_y),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) - 'created_by' order by e.category, e.service)
                          from public.mvl_operating_expenses e where e.month = m), '[]'::jsonb)
  );
end;
$$;

create or replace function public.mvl_admin_update_settings(
  p_ai_mode text default null, p_ai_paused_message text default null,
  p_daily_budget numeric default null, p_monthly_budget numeric default null,
  p_fx_usd_to_eur numeric default null, p_vat_rate numeric default null, p_prices_include_vat boolean default null
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  update public.mvl_app_settings set
    ai_mode = coalesce(p_ai_mode, ai_mode),
    ai_paused_message = case when p_ai_paused_message is null then ai_paused_message else nullif(btrim(p_ai_paused_message), '') end,
    daily_ai_budget_usd = coalesce(p_daily_budget, daily_ai_budget_usd),
    monthly_ai_budget_usd = coalesce(p_monthly_budget, monthly_ai_budget_usd),
    fx_usd_to_eur = coalesce(p_fx_usd_to_eur, fx_usd_to_eur),
    vat_rate = coalesce(p_vat_rate, vat_rate),
    prices_include_vat = coalesce(p_prices_include_vat, prices_include_vat),
    updated_at = now(), updated_by = (select auth.uid())
  where id;
end;
$$;

create or replace function public.mvl_admin_update_plan_limits(
  p_plan text, p_captures integer, p_minutes integer, p_max_seconds integer, p_per_hour integer, p_per_day integer
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  update public.mvl_plan_limits set
    ai_captures_per_month = p_captures, audio_minutes_per_month = p_minutes, max_capture_seconds = p_max_seconds,
    captures_per_hour = p_per_hour, captures_per_day = p_per_day, updated_at = now()
  where plan = p_plan;
  if not found then raise exception 'unknown plan %', p_plan; end if;
end;
$$;

create or replace function public.mvl_admin_add_expense(
  p_month date, p_service text, p_category text, p_amount numeric, p_currency text, p_kind text, p_note text default null
) returns bigint language plpgsql security definer set search_path = ''
as $$
declare v_id bigint;
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  insert into public.mvl_operating_expenses (month, service, category, amount, currency, kind, note, created_by)
  values (date_trunc('month', p_month)::date, btrim(p_service), p_category, p_amount, p_currency, p_kind, nullif(btrim(p_note), ''), (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.mvl_admin_delete_expense(p_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  delete from public.mvl_operating_expenses where id = p_id;
end;
$$;

create or replace function public.mvl_admin_ack_alert(p_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.mvl_is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  update public.mvl_budget_alerts set acknowledged_at = now() where id = p_id and acknowledged_at is null;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security and privileges
-- ---------------------------------------------------------------------
alter table public.mvl_app_settings enable row level security;
alter table public.mvl_staff enable row level security;
alter table public.mvl_plan_limits enable row level security;
alter table public.mvl_plan_prices enable row level security;
alter table public.mvl_fee_schedules enable row level security;
alter table public.mvl_price_book enable row level security;
alter table public.mvl_ai_usage enable row level security;
alter table public.mvl_budget_alerts enable row level security;
alter table public.mvl_operating_expenses enable row level security;
alter table public.mvl_daily_activity enable row level security;

-- Users may read their own usage rows (no content in them) and the public plan/price lists.
drop policy if exists "mvl_ai_usage: owner can read" on public.mvl_ai_usage;
create policy "mvl_ai_usage: owner can read" on public.mvl_ai_usage
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "mvl_plan_limits: signed-in can read" on public.mvl_plan_limits;
create policy "mvl_plan_limits: signed-in can read" on public.mvl_plan_limits for select to authenticated using (true);
drop policy if exists "mvl_plan_prices: signed-in can read" on public.mvl_plan_prices;
create policy "mvl_plan_prices: signed-in can read" on public.mvl_plan_prices for select to authenticated using (true);

-- No client writes to any financial table; no client access at all to the rest.
revoke all on public.mvl_app_settings, public.mvl_staff, public.mvl_plan_limits, public.mvl_plan_prices,
  public.mvl_fee_schedules, public.mvl_price_book, public.mvl_ai_usage, public.mvl_budget_alerts,
  public.mvl_operating_expenses, public.mvl_daily_activity from anon, authenticated;
grant select on public.mvl_ai_usage, public.mvl_plan_limits, public.mvl_plan_prices to authenticated;
revoke all on sequence public.mvl_plan_prices_id_seq, public.mvl_fee_schedules_id_seq, public.mvl_price_book_id_seq,
  public.mvl_budget_alerts_id_seq, public.mvl_operating_expenses_id_seq from anon, authenticated;

-- Functions: lock everything down, then grant precisely.
do $$
declare fn text;
begin
  foreach fn in array array[
    'mvl_staff_role(uuid)', 'mvl_is_admin()', 'mvl_current_price(text,text)',
    'mvl_capture_cost_ceiling(public.mvl_price_book,numeric)', 'mvl_spend_since(timestamptz)',
    'mvl_maybe_alert(text,date,numeric,numeric)',
    'mvl_reserve_ai_capture(uuid,text,numeric,text,text)', 'mvl_record_ai_call(uuid,integer,integer,integer,integer)',
    'mvl_finish_ai_capture(uuid,text,text)', 'mvl_my_usage()', 'mvl_touch_activity()',
    'mvl_admin_usage_summary(date)', 'mvl_admin_finance_summary(date)',
    'mvl_admin_update_settings(text,text,numeric,numeric,numeric,numeric,boolean)',
    'mvl_admin_update_plan_limits(text,integer,integer,integer,integer,integer)',
    'mvl_admin_add_expense(date,text,text,numeric,text,text,text)', 'mvl_admin_delete_expense(bigint)',
    'mvl_admin_ack_alert(bigint)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
  end loop;
end $$;

-- Edge Function (service role) only: the accounting path.
grant execute on function public.mvl_reserve_ai_capture(uuid, text, numeric, text, text) to service_role;
grant execute on function public.mvl_record_ai_call(uuid, integer, integer, integer, integer) to service_role;
grant execute on function public.mvl_finish_ai_capture(uuid, text, text) to service_role;

-- Signed-in users: own usage + activity marker; admin RPCs check mvl_is_admin() inside.
grant execute on function public.mvl_my_usage() to authenticated;
grant execute on function public.mvl_touch_activity() to authenticated;
grant execute on function public.mvl_is_admin() to authenticated;
grant execute on function public.mvl_admin_usage_summary(date) to authenticated;
grant execute on function public.mvl_admin_finance_summary(date) to authenticated;
grant execute on function public.mvl_admin_update_settings(text, text, numeric, numeric, numeric, numeric, boolean) to authenticated;
grant execute on function public.mvl_admin_update_plan_limits(text, integer, integer, integer, integer, integer) to authenticated;
grant execute on function public.mvl_admin_add_expense(date, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.mvl_admin_delete_expense(bigint) to authenticated;
grant execute on function public.mvl_admin_ack_alert(bigint) to authenticated;
