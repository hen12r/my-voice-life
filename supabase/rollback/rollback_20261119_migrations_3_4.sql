-- =====================================================================
-- ROLLBACK for migrations 3 and 4 (20261119000001 + 20261119000002).
-- NOT a migration: it lives outside supabase/migrations/ so it is never applied automatically.
-- Running it against the real project requires the owner's explicit approval.
-- ---------------------------------------------------------------------
-- Run as ONE transaction (psql --single-transaction, or the SQL editor, which wraps it).
-- It refuses, and changes nothing, if rolling back would destroy information:
--   * any profile already uses a language outside the old en/fr/rw list
--     (the old constraints could not be restored without overwriting users' choices);
--   * any recorded AI usage references the OpenAI price rows
--     (deleting them would erase cost history).
-- In those cases use the recovery steps in docs/MIGRATION_3_4_AND_TESTER_REVIEW.md instead
-- (kill switch first; fix forward).
-- What is lost on rollback: users' list of up to 3 spoken languages (speech_languages).
-- Their single spoken language (speech_language) and every note, task, event and reminder stay.
-- =====================================================================

do $$ begin
  if exists (select 1 from public.profiles
              where ui_language not in ('en', 'fr', 'rw')
                 or speech_language not in ('auto', 'en', 'fr', 'rw')) then
    raise exception 'MVL rollback refused: some profiles use languages outside en/fr/rw. Nothing was changed.';
  end if;
  if exists (select 1 from public.mvl_ai_usage u join public.mvl_price_book p on p.id = u.price_book_id
              where p.provider = 'openai') then
    raise exception 'MVL rollback refused: AI usage already references the OpenAI prices (cost history). Nothing was changed.';
  end if;
end $$;

-- ---- Undo migration 4 (multilingual) ----
revoke update (speech_languages) on public.profiles from authenticated;
alter table public.profiles drop constraint if exists mvl_profiles_speech_languages_chk;
alter table public.profiles drop column if exists speech_languages;
alter table public.profiles drop constraint if exists mvl_profiles_ui_language_code_chk;
alter table public.profiles drop constraint if exists mvl_profiles_speech_language_code_chk;
alter table public.profiles add constraint profiles_ui_language_chk check (ui_language in ('en', 'fr', 'rw'));
alter table public.profiles add constraint profiles_speech_language_chk check (speech_language in ('auto', 'en', 'fr', 'rw'));
drop function if exists public.mvl_valid_language_codes(text[]);

-- ---- Undo migration 3 (OpenAI pricing) ----
drop function if exists public.mvl_record_ai_transcription(uuid, numeric);

-- Original worst-case cost function, exactly as in 20261118000002 (create or replace keeps
-- its existing lockdown: no EXECUTE for anon/authenticated).
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

delete from public.mvl_price_book
 where provider = 'openai' and model in ('gpt-transcribe+gpt-6-luna', 'gpt-6-luna') and effective_from = '2026-11-19';
alter table public.mvl_price_book drop constraint if exists mvl_price_book_audio_minute_chk;
alter table public.mvl_price_book drop column if exists audio_usd_per_minute;

-- Keep Supabase's migration history consistent, so the two migrations can be re-applied later.
do $$ begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    delete from supabase_migrations.schema_migrations where version in ('20261119000001', '20261119000002');
  end if;
end $$;
