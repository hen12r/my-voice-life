-- Schedules reminder notifications: every minute, the database calls the send-reminders function.
-- NEVER applied automatically. Run it ONCE, by hand, in the Supabase SQL editor, only after the
-- owner's approval and after every step before it in docs/PUSH_SETUP.md:
--   migration 7 applied · pg_cron + pg_net enabled · VAPID_* and CRON_SECRET function secrets set ·
--   push + send-reminders deployed · Vault secret "mvl_cron_secret" created (same value as CRON_SECRET,
--   entered in Dashboard → Project Settings → Vault, never pasted into SQL or chat).
-- Undo at any time:  select cron.unschedule('mvl-send-reminders');

do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then raise exception 'Enable the pg_cron extension first.'; end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then raise exception 'Enable the pg_net extension first.'; end if;
  if to_regprocedure('public.mvl_push_claim_due(integer)') is null then raise exception 'Apply migration 7 (20261128000001_mvl_push.sql) first.'; end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'mvl_cron_secret') then raise exception 'Create the Vault secret mvl_cron_secret first.'; end if;
end $$;

-- Re-runnable: replaces the job if it already exists.
select cron.unschedule(jobid) from cron.job where jobname = 'mvl-send-reminders';
select cron.schedule('mvl-send-reminders', '* * * * *', $job$
  select net.http_post(
    url := 'https://nwglzabnezhmxfyuxhmg.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mvl-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'mvl_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000)
$job$);
