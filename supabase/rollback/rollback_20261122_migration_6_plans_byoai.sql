-- =====================================================================
-- ROLLBACK for migration 6 (20261122000001_mvl_plans_byoai.sql).
-- NOT a migration (never applied automatically). Running it on the real project needs the
-- owner's explicit approval. Run as ONE transaction.
-- It REFUSES, changing nothing, once any state that only migration 6 can represent exists:
--   * a user-provided AI key (mvl_ai_connections) — removing it would destroy user data;
--   * BYOAI usage records;
--   * a subscription on plus/pro that is linked to Stripe (a paying customer).
-- In those cases: switch BYOAI off (byoai_mode = 'off') and fix forward instead.
-- Function bodies below are copied verbatim from migrations 1, 2 and 5 (generated, not retyped).
-- =====================================================================

do $$ begin
  if exists (select 1 from public.mvl_ai_connections) then
    raise exception 'MVL rollback refused: users have connected AI keys. Nothing was changed.';
  end if;
  if exists (select 1 from public.mvl_byoai_usage) then
    raise exception 'MVL rollback refused: BYOAI usage has been recorded. Nothing was changed.';
  end if;
  if exists (select 1 from public.subscriptions where plan in ('plus', 'pro') and stripe_subscription_id is not null) then
    raise exception 'MVL rollback refused: Stripe subscriptions exist on plus/pro. Nothing was changed.';
  end if;
end $$;

-- BYOAI
drop function if exists public.mvl_reserve_byoai_capture(uuid, text, numeric);
drop function if exists public.mvl_record_byoai_call(uuid, numeric, integer, integer);
drop function if exists public.mvl_finish_byoai_capture(uuid, text, text);
drop function if exists public.mvl_byoai_set_key(uuid, text, text, text);
drop function if exists public.mvl_byoai_get_key(uuid, text);
drop function if exists public.mvl_byoai_delete_key(uuid, text);
drop function if exists public.mvl_byoai_mark_invalid(uuid, text);
drop table if exists public.mvl_byoai_usage;
drop table if exists public.mvl_ai_connections;
drop function if exists public.mvl_ai_connection_drop_secret();

-- Caps
drop trigger if exists mvl_reminders_cap on public.reminders;
drop trigger if exists mvl_events_cap on public.events;
drop function if exists public.mvl_enforce_reminder_cap();
drop function if exists public.mvl_enforce_event_cap();

-- Admin RPCs added by migration 6
drop function if exists public.mvl_admin_update_plan_caps(text, integer, integer, integer, integer, integer, integer);
drop function if exists public.mvl_admin_update_billing_settings(text, integer);

-- Plans back to free / premium (unlinked plus/pro rows become premium; none are linked to Stripe).
alter table public.subscriptions drop constraint if exists mvl_subscriptions_plan_chk;
alter table public.mvl_plan_limits drop constraint if exists mvl_plan_limits_plan_chk;
update public.subscriptions set plan = 'premium' where plan in ('plus', 'pro');
insert into public.mvl_plan_limits (plan, ai_captures_per_month, audio_minutes_per_month, max_capture_seconds, captures_per_hour, captures_per_day)
select 'premium', ai_captures_per_month, audio_minutes_per_month, max_capture_seconds, captures_per_hour, captures_per_day
from public.mvl_plan_limits where plan = 'plus'
on conflict (plan) do nothing;
delete from public.mvl_plan_prices where plan in ('plus', 'pro');
insert into public.mvl_plan_prices (plan, billing_interval, amount_cents, currency, active_from)
values ('premium', 'month', 499, 'EUR', '2026-01-01'), ('premium', 'year', 3999, 'EUR', '2026-01-01')
on conflict do nothing;
delete from public.mvl_plan_limits where plan in ('plus', 'pro');
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('free', 'premium'));
alter table public.mvl_plan_limits add constraint mvl_plan_limits_plan_check check (plan in ('free', 'premium'));
alter table public.mvl_plan_limits drop column if exists max_active_reminders;
alter table public.mvl_plan_limits drop column if exists max_upcoming_events;
alter table public.mvl_plan_limits drop column if exists max_ai_connections;
alter table public.mvl_plan_limits drop column if exists byoai_captures_per_hour;
alter table public.mvl_plan_limits drop column if exists byoai_captures_per_day;
alter table public.mvl_plan_limits drop column if exists byoai_max_capture_seconds;

-- Functions restored to their pre-migration-6 definitions (migration 1, 2 and 5 text).
create or replace function public.effective_plan(p_user uuid)
returns text language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select s.plan from public.subscriptions s
    where s.user_id = p_user
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  ), 'free');
$$;
revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;

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
revoke execute on function public.mvl_my_usage() from public, anon;
grant execute on function public.mvl_my_usage() to authenticated;

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
revoke execute on function public.mvl_admin_finance_summary(date) from public, anon;
grant execute on function public.mvl_admin_finance_summary(date) to authenticated;

drop function if exists public.mvl_billing_apply_subscription_v2(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid, text);
create or replace function public.mvl_billing_apply_subscription(
  p_event_id text, p_event_type text, p_event_created timestamptz, p_livemode boolean,
  p_customer text, p_subscription text, p_status text, p_price_id text, p_interval text,
  p_period_end timestamptz, p_cancel_at_period_end boolean, p_metadata_user uuid)
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

  -- Idempotency: a repeated event changes nothing.
  insert into public.mvl_stripe_events (event_id, event_type, stripe_created, livemode, outcome)
  values (p_event_id, p_event_type, p_event_created, p_livemode, 'applied')
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select user_id into v_user from public.subscriptions where stripe_customer_id = p_customer;

  if v_user is null then
    v_outcome := 'unlinked';                  -- a customer we never created for anyone
  elsif p_metadata_user is not null and p_metadata_user <> v_user then
    v_outcome := 'user_mismatch';             -- never move a subscription between users
  else
    select * into s from public.subscriptions where user_id = v_user for update;
    -- An event about an OLD subscription must not overwrite a different, current one.
    if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription
       and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'paused')
       and p_status in ('canceled', 'incomplete_expired', 'incomplete') then
      v_outcome := 'ignored_other_subscription';
    else
      v_outcome := 'applied';
      v_plan := case when p_status in ('canceled', 'incomplete_expired') then 'free' else 'premium' end;
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
revoke execute on function public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid) to service_role;

-- Settings columns last (effective_plan above no longer reads them).
alter table public.mvl_app_settings drop column if exists byoai_mode;
alter table public.mvl_app_settings drop column if exists billing_grace_days;

do $$ begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261122000001';
  end if;
end $$;
