# Review: migrations 3–4 and tester access

**Status:** for your review only. **Nothing here has been applied.** The live database is unchanged.

**Live state, checked with read-only queries on 2026-11-20:**
- 2 accounts;
- 0 staff rows;
- `ai_mode = admins_only`;
- both profiles have spoken language `auto`;
- the price book holds only the 2 old Gemini rows.

---

## Migration 3: `20261119000001_mvl_openai_pricing.sql`
**Purpose:** OpenAI bills transcription **per minute of audio**, not per token. The cost controls must know that price before any voice capture is allowed. Without this migration, voice fails closed with "ai_price_unknown". That is safe, but voice can't work.

| What | Change | Who can use it |
|---|---|---|
| Table `mvl_price_book` | **adds column** `audio_usd_per_minute` (default 0, cannot be negative); existing Gemini rows get 0 | no client access (unchanged) |
| Table `mvl_price_book` | **inserts 2 rows**: `gpt-transcribe+gpt-6-luna` ($0.0045/min audio, $0.10/$0.50 per 1M tokens) and `gpt-6-luna` (text only) | no client access |
| Function `mvl_capture_cost_ceiling` | **replaced**, same name and arguments: the worst-case cost now adds seconds ÷ 60 × the per-minute price. For the Gemini rows (rate 0) the result is identical. | existing permissions kept: not callable by users |
| Function `mvl_record_ai_transcription` | **new**: books a transcription's billed seconds × price on an active reservation; rejects negative values or more than 2 hours | **service role only** (the Edge Function); explicitly revoked from `public`, `anon`, `authenticated` |

- **Not touched:** user tables, notes, tasks, profiles, RLS policies, budgets, limits, the kill switch, `ai_mode`.
- **Data deleted:** none.

## Migration 4: `20261119000002_mvl_multilingual.sql`
**Purpose:** lets each person choose up to 3 spoken languages (for example Kinyarwanda + French + English). These are sent to transcription as hints. The interface language becomes open-ended, so languages are no longer limited to `en/fr/rw`.

| What | Change | Who can use it |
|---|---|---|
| Function `mvl_valid_language_codes(text[])` | **new**: a pure check that each code looks like `rw`, `fr` or `pt-br`. It reads no table. | callable by signed-in users (default). It only validates text and reveals nothing. |
| Table `profiles`: constraints | **drops** `profiles_ui_language_chk` and `profiles_speech_language_chk` (both created by migration 1, confirmed present live), and **adds** code-format checks in their place. This **loosens** the rule: any well-formed language code is accepted, not only en/fr/rw. | n/a |
| Table `profiles`: column | **adds** `speech_languages text[]`, default empty, at most 3 well-formed codes | owner only |
| Table `profiles`: data | **one UPDATE** copies an existing single spoken language into the new list. **Today it changes 0 rows**: both profiles are `auto`. | n/a |
| Permission | `grant update (speech_languages) on profiles to authenticated`: a column-level grant. The existing **owner-only RLS policy still applies**, so a person can change only their own row. | owner only |

- **Not touched:** RLS policies, notes, tasks, events, reminders, financial tables, staff.
- **Data deleted:** none.

## How they are tested
- **Automated:** `npm run test:db` applies all 4 migrations to a throwaway local Postgres. It applies them twice, to prove they are idempotent, and runs 160+ checks, including `supabase/tests/openai_multilingual_test.sql`. CI runs the same suite on every push.
- **Not tested:** applying them to the live project. That needs your approval.

## If you approve
1. I apply each file **unchanged** with the Supabase connector, under the same version numbers.
2. I re-run the read-only check and confirm that:
   - the 2 price rows exist;
   - the column and constraints exist;
   - 0 profile rows changed;
   - the security advisor shows nothing new.
3. I report back. Nothing else changes: no staff row, no deploy, no `ai_mode` change.

## Elevated functions and who can execute them
Elevated (`SECURITY DEFINER`) functions run with the owner's rights, so the question that matters is who may call them. This is checked in the catalogue (`has_function_privilege`) **and** by calling each function as a user. The call must fail with a permission error (SQLSTATE 42501), not because of a bad argument.

| Function | Elevated? | `anon` | `authenticated` | `service_role` (Edge Function) | How the right is set |
|---|---|---|---|---|---|
| `mvl_record_ai_transcription` (new, migration 3) | yes | **no** | **no** | yes | `revoke … from public, anon, authenticated; grant … to service_role` in the migration |
| `mvl_capture_cost_ceiling` (replaced, migration 3) | yes | **no** | **no** | via reservation only | revoked in migration 2. `create or replace` keeps the existing rights, and the tests prove the lockdown survives |
| `mvl_valid_language_codes` (new, migration 4) | **no** (runs with the caller's rights) | default | default | default | pure text check, reads no table |

## Language codes and the English fallback
- **The database checks the format.** A code must look like `rw`, `fr`, `yue` or `pt-br`: lower case, 2–3 letters, optional region. Names (`Kinyarwanda`), upper case (`FR`), one letter, injection-looking text and more than 3 spoken languages are all rejected. This is tested.
- **The app falls back to English** for any interface language without a translation, including codes it has never heard of. Dates and numbers use that language's locale, or `en-GB` when it is unknown. Unit tests cover `sw`, `rw`, `zh-cn` and `xx`. French stays French. Only English (reviewed) and French (draft) are translated today.
- **Spoken languages are hints only.** If OpenAI rejects one, the request is retried once without hints (this is tested). It is never a hard failure.

## Rollback and recovery
**First response to any problem: the kill switch.** It changes no schema, is instant and reversible, and stops every AI call, including testers':
```sql
update public.mvl_app_settings set ai_mode = 'off';   -- undo: set back to 'admins_only'
```

**Full rollback of migrations 3–4:** [`supabase/rollback/rollback_20261119_migrations_3_4.sql`](../supabase/rollback/rollback_20261119_migrations_3_4.sql). It is not a migration and is never applied automatically. Running it on the live project needs your approval.
- It runs as one transaction, and **refuses without changing anything** if rolling back would destroy information:
  - a profile already uses a language outside en/fr/rw;
  - recorded AI usage already references the OpenAI prices (cost history).
- Otherwise it restores the previous state exactly:
  - drops the new column, constraints and functions;
  - restores the old en/fr/rw checks;
  - restores the original cost function, with its lockdown;
  - deletes the 2 OpenAI price rows;
  - removes the 2 versions from Supabase's migration history, so they can be re-applied.
- **What it loses:** users' lists of up to 3 spoken languages. Notes, tasks, events, reminders and the single spoken-language setting are kept.
- **Tested** in `npm run test:db`, "rollback" scenario:
  - both refusals leave the schema untouched;
  - a clean rollback restores the pre-migration state and keeps notes;
  - the migrations re-apply cleanly afterwards.

**When the rollback refuses** (real usage exists), fix forward instead: kill switch, then a new additive migration. Cost history is never deleted to make a rollback possible.

**Backups:** check the Supabase dashboard (Database → Backups) to see what your plan includes before approving. I haven't verified it for this project.

---

## Tester access (separate approval)
**Account:** the confirmed "hen…" account you chose, user id `3c30d720-400f-4956-9c11-ed5dec974d1c`. It is targeted by id, not by email, so it cannot hit the wrong account. It is also guarded so that it does nothing unless that account is confirmed.

```sql
insert into public.mvl_staff (user_id, role)
select id, 'tester' from auth.users
 where id = '3c30d720-400f-4956-9c11-ed5dec974d1c'
   and email_confirmed_at is not null
on conflict (user_id) do nothing;
```
It adds **one row** to `mvl_staff`. No permission, policy, function or other table changes.

**What `tester` allows:** exactly one thing. While AI is in `admins_only` test mode, the reservation function lets staff through (`ai_mode = 'admins_only' and role is null` → refused). That is the whole difference.

**What a tester still cannot do.** Every item below is proven by `supabase/tests/financial_test.sql`. Each check requires a real authorisation refusal (SQLSTATE 42501), not just any error.
- `mvl_is_admin()` returns false; `mvl_my_usage()` reports `is_admin: false`. The Admin page and nav link stay hidden, and the page redirects away.
- It cannot read the usage or finance dashboards.
- It cannot change settings, budgets or the kill switch.
- It cannot change plan limits.
- It cannot add or delete expenses, or acknowledge budget alerts.
- It cannot read the staff list, promote itself to admin, or grant access to anyone.
- It cannot call the reservation function directly; it must go through the Edge Function.
- It cannot see other users' notes or usage. Owner-only RLS is unchanged.
- **Mutation check:** making the test user an admin makes the suite fail ("tester: is_admin false").

**A tester is still limited like everyone else.** The Free plan allows 7 voice captures a month, plus the hourly and daily rate limits and the $2/day and $20/month budgets. The kill switch (`ai_mode = 'off'`) stops testers too.

**Check, after applying** (read-only):
```sql
select role from public.mvl_staff where user_id = '3c30d720-400f-4956-9c11-ed5dec974d1c';  -- tester
```
**Undo:**
```sql
delete from public.mvl_staff where user_id = '3c30d720-400f-4956-9c11-ed5dec974d1c' and role = 'tester';
```

**Note:** without migrations 3–4, the deployed function and an OpenAI key, tester access does nothing visible. Voice still says AI is unavailable. You can approve these steps in any order.

---

## Appendix: exact migration text (verbatim from the branch)

### Migration 3
```sql
-- =====================================================================
-- My Voice Life — OpenAI pricing for the voice pipeline (additive)
-- ---------------------------------------------------------------------
-- gpt-transcribe is billed per MINUTE of audio (not per token), so the price book gains a
-- per-minute rate, the worst-case hold includes it, and transcription calls are recorded by
-- duration. Prices verified on developers.openai.com on 2026-11-19:
--   gpt-transcribe  $0.0045 / minute         (docs/models/gpt-transcribe)
--   gpt-6-luna      $0.10 in / $0.50 out per 1M tokens (docs/models/gpt-6-luna)
-- The old Gemini rows are left untouched (inert: the code no longer requests them).
-- =====================================================================

do $$ begin
  if to_regclass('public.mvl_price_book') is null or to_regclass('public.mvl_ai_usage') is null then
    raise exception 'MVL pre-flight: apply 20261118000002_mvl_financial_controls.sql first.';
  end if;
end $$;

alter table public.mvl_price_book add column if not exists audio_usd_per_minute numeric(10, 6) not null default 0;
do $$ begin
  alter table public.mvl_price_book add constraint mvl_price_book_audio_minute_chk check (audio_usd_per_minute >= 0);
exception when duplicate_object then null; end $$;

-- One row per pipeline: voice capture = transcription + extraction; typed capture = extraction only.
insert into public.mvl_price_book (provider, model, audio_in_usd_per_m, text_in_usd_per_m, output_usd_per_m, audio_usd_per_minute, effective_from, source_url)
values ('openai', 'gpt-transcribe+gpt-6-luna', 0, 0.10, 0.50, 0.0045, '2026-11-19', 'https://developers.openai.com/api/docs/pricing'),
       ('openai', 'gpt-6-luna', 0, 0.10, 0.50, 0, '2026-11-19', 'https://developers.openai.com/api/docs/models/gpt-6-luna')
on conflict (provider, model, effective_from) do nothing;

-- Worst-case USD cost of one capture, now including per-minute audio billing
-- (rounded up to whole seconds).
create or replace function public.mvl_capture_cost_ceiling(p_price public.mvl_price_book, p_audio_seconds numeric)
returns numeric language sql stable security definer set search_path = ''
as $$
  select round((
      ceil(p_audio_seconds * 32) * p_price.audio_in_usd_per_m
    + s.max_text_in_tokens_per_capture * p_price.text_in_usd_per_m
    + 2 * s.max_output_tokens_per_call * p_price.output_usd_per_m
  ) / 1000000.0
    + ceil(p_audio_seconds) / 60.0 * p_price.audio_usd_per_minute, 6)
  from public.mvl_app_settings s
$$;

-- Records a per-minute transcription call on a reservation: cost = seconds × rate, and the
-- capture's audio length becomes the duration the provider billed (or the server-measured one).
create or replace function public.mvl_record_ai_transcription(p_reservation uuid, p_audio_seconds numeric)
returns numeric language plpgsql security definer set search_path = ''
as $$
declare r public.mvl_ai_usage; p public.mvl_price_book; v_cost numeric;
begin
  if p_audio_seconds is null or p_audio_seconds < 0 or p_audio_seconds > 7200 then
    raise exception 'invalid audio duration';
  end if;
  select * into r from public.mvl_ai_usage where id = p_reservation for update;
  if r.id is null or r.status <> 'reserved' then
    raise exception 'reservation % is not active', p_reservation;
  end if;
  select * into p from public.mvl_price_book where id = r.price_book_id;
  v_cost := ceil(p_audio_seconds) / 60.0 * coalesce(p.audio_usd_per_minute, 0);
  update public.mvl_ai_usage set
    provider_calls = provider_calls + 1,
    est_cost_usd = round(est_cost_usd + v_cost, 6),
    audio_seconds = round(p_audio_seconds, 2)
  where id = p_reservation;
  return round(v_cost, 6);
end;
$$;

-- Accounting path: Edge Function (service role) only.
revoke execute on function public.mvl_record_ai_transcription(uuid, numeric) from public, anon, authenticated;
grant execute on function public.mvl_record_ai_transcription(uuid, numeric) to service_role;
```

### Migration 4
```sql
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
```
