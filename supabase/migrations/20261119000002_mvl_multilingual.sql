-- =====================================================================
-- My Voice Life — multilingual profiles (additive)
-- ---------------------------------------------------------------------
-- Interface language and spoken languages become separate, open-ended settings:
--   ui_language       one ISO 639 code (the app falls back to English for untranslated ones)
--   speech_languages  up to 3 ISO 639 codes the user speaks; sent to transcription as hints
--   speech_language   kept for compatibility ('auto' or the first spoken language)
-- Which languages exist, and how well each is supported, lives in the shared registry
-- (supabase/functions/_shared/languages.ts); the database only enforces the code format.
-- =====================================================================

do $$ begin
  if to_regclass('public.profiles') is null then
    raise exception 'MVL pre-flight: apply 20261118000001_my_voice_life_core.sql first.';
  end if;
end $$;

create or replace function public.mvl_valid_language_codes(p_codes text[])
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(bool_and(c ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'), true) from unnest(p_codes) as c
$$;

-- Replace the fixed en/fr/rw lists with a code-format check.
alter table public.profiles drop constraint if exists profiles_ui_language_chk;
alter table public.profiles drop constraint if exists profiles_speech_language_chk;
do $$ begin
  alter table public.profiles add constraint mvl_profiles_ui_language_code_chk
    check (ui_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.profiles add constraint mvl_profiles_speech_language_code_chk
    check (speech_language = 'auto' or speech_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$');
exception when duplicate_object then null; end $$;

alter table public.profiles add column if not exists speech_languages text[] not null default '{}';
do $$ begin
  alter table public.profiles add constraint mvl_profiles_speech_languages_chk
    check (cardinality(speech_languages) <= 3 and public.mvl_valid_language_codes(speech_languages));
exception when duplicate_object then null; end $$;

-- Carry over an existing single spoken-language choice.
update public.profiles set speech_languages = array[speech_language]
 where speech_language <> 'auto' and speech_languages = '{}';

-- Owners may change it like their other preferences (column-level grant, RLS still applies).
grant update (speech_languages) on public.profiles to authenticated;
