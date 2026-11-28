-- READ-ONLY pre-flight for migration 7 (reminder notifications). Changes nothing.
-- Run on the live project before approving migration 7, and paste the result into the approval.
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename = 'mvl_push_subscriptions') as push_table_already_exists,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'mvl\_push\_%') as push_functions_already_exist,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'reminders' and column_name = 'last_notified_at') = 1 as reminders_have_last_notified_at,
  (select count(*) from public.reminders where status = 'scheduled') as scheduled_reminders,
  -- Reminders that would be eligible the moment sending starts (due in the last hour, never notified).
  -- Expected 0 devices at that point, so nothing is sent until someone turns notifications on.
  (select count(*) from public.reminders where status = 'scheduled'
     and remind_at <= now() and remind_at > now() - interval '1 hour'
     and (last_notified_at is null or last_notified_at < remind_at)) as due_in_last_hour,
  (select count(*) from pg_extension where extname = 'pg_cron') as pg_cron_installed,
  (select count(*) from pg_extension where extname = 'pg_net') as pg_net_installed;
