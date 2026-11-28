-- Rollback of migration 7 (reminder notifications / Web Push). NEVER applied automatically.
-- Run only with the owner's approval, AFTER unscheduling the sender:
--   select cron.unschedule('mvl-send-reminders');   (if supabase/ops/schedule_send_reminders.sql was run)
-- What is lost: the list of devices that turned notifications on (users can turn them on again).
-- No user content is touched: reminders keep every column, including last_notified_at, which
-- existed before migration 7.
do $$ begin
  raise notice 'MVL rollback 7: % push device registration(s) will be removed.',
    (select count(*) from public.mvl_push_subscriptions);
end $$;

drop function if exists public.mvl_push_subscribe(text, text, text, text);
drop function if exists public.mvl_push_unsubscribe(text);
drop function if exists public.mvl_push_claim_due(integer);
drop function if exists public.mvl_push_targets(uuid[]);
drop function if exists public.mvl_push_record_result(uuid, boolean, boolean);
drop table if exists public.mvl_push_subscriptions;
