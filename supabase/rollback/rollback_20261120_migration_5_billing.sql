-- =====================================================================
-- ROLLBACK for migration 5 (20261120000001_mvl_stripe_billing.sql).
-- NOT a migration (never applied automatically). Running it on the real project needs the
-- owner's explicit approval. Run as ONE transaction.
-- It REFUSES, changing nothing, once any real billing state exists — a Stripe customer or
-- subscription linked to a user, a Stripe-only status, or a processed webhook event — because
-- removing it would orphan paying customers. Then: stop Stripe (remove the webhook endpoint /
-- the STRIPE_SECRET_KEY secret) and fix forward instead.
-- =====================================================================

do $$ begin
  if exists (select 1 from public.subscriptions where stripe_customer_id is not null or stripe_subscription_id is not null
             or status not in ('active', 'trialing', 'past_due', 'canceled')) then
    raise exception 'MVL rollback refused: billing data exists (Stripe customers/subscriptions or Stripe-only statuses). Nothing was changed.';
  end if;
  if to_regclass('public.mvl_stripe_events') is not null and exists (select 1 from public.mvl_stripe_events) then
    raise exception 'MVL rollback refused: Stripe webhook events have been processed. Nothing was changed.';
  end if;
end $$;

drop function if exists public.mvl_billing_apply_subscription(text, text, timestamptz, boolean, text, text, text, text, text, timestamptz, boolean, uuid);
drop function if exists public.mvl_billing_link_customer(uuid, text);
drop table if exists public.mvl_stripe_events;
alter table public.subscriptions drop constraint if exists mvl_subscriptions_stripe_ids_chk;
alter table public.subscriptions drop column if exists stripe_synced_at;
alter table public.subscriptions drop column if exists stripe_livemode;
alter table public.subscriptions drop column if exists stripe_price_id;
alter table public.subscriptions drop column if exists cancel_at_period_end;
alter table public.subscriptions drop constraint if exists mvl_subscriptions_status_chk;
alter table public.subscriptions add constraint subscriptions_status_check check (status in ('active', 'trialing', 'past_due', 'canceled'));

do $$ begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version = '20261120000001';
  end if;
end $$;
