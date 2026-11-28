-- READ-ONLY pre-flight for migration 6 (20261122000001_mvl_plans_byoai.sql).
-- Run it on the real project BEFORE approving the migration. It changes nothing.
-- Every figure is a count; no emails, notes or other personal content are returned.

select 'subscriptions on legacy premium (will become plus)' as check, count(*)::text as value
  from public.subscriptions where plan = 'premium'
union all
select 'subscriptions linked to Stripe', count(*)::text
  from public.subscriptions where stripe_subscription_id is not null
union all
select 'Supabase Vault available', (to_regprocedure('vault.create_secret(text,text,text,uuid)') is not null)::text
union all
select 'Vault secrets already present', (select count(*) from vault.secrets)::text
union all
select 'users who would exceed the free cap of 10 active reminders', count(*)::text
  from (select user_id from public.reminders where status = 'scheduled' group by user_id having count(*) > 10) x
union all
select 'users who would exceed the free cap of 20 upcoming events', count(*)::text
  from (select user_id from public.events where starts_at > now() group by user_id having count(*) > 20) x
union all
select 'migration 6 already applied', exists (
  select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mvl_plan_limits' and column_name = 'byoai_captures_per_day')::text
union all
select 'ai_mode (unchanged by migration 6)', (select ai_mode from public.mvl_app_settings);
-- Users above a cap keep every existing item; they just can't add more until under the cap or on Plus/Pro.
