# Migration review

Two migrations, applied in order. **Neither has been applied to any remote database.** Both wait for the owner's explicit approval.

# 1. `20261118000001_my_voice_life_core.sql`

**Status: prepared, tested locally, NOT applied anywhere remote. Waiting for the owner's approval.**

## Summary for the decision
| Question | Answer |
|---|---|
| Does it delete data? | **No.** No `DROP TABLE`, `DROP COLUMN`, `DELETE`, `TRUNCATE`, column type change, or `UPDATE` of existing rows. |
| Does it change existing data? | It **adds** columns to existing `profiles` rows (filled with defaults) and **adds** rows: one `subscriptions` row per existing user and a `profiles` row for any user who lacks one. Existing values are never overwritten. |
| What does it remove? | Security rules only: **all existing RLS policies on `profiles`** (replaced with owner-only ones) and client `UPDATE` rights on `profiles` except preference columns. |
| Does it touch FitPick's `outfits` table? | No. |
| Does it touch existing functions or triggers? | No. Every function and trigger it creates has a unique name (`mvl_*`, `on_auth_user_created_zz_mvl`, `tasks_completed_at`, …). The pre-flight check confirms none exist yet. |
| Is it atomic? | Yes. It was tested with `psql --single-transaction`; if any statement fails, nothing is applied. Built-in guards abort before any change if the schema isn't what it expects. |
| Can it run twice? | Yes (tested). |
| Tested? | 51 automated checks over three scenarios: fresh project, simulated FitPick project, conflicting table. See "Evidence" below. |

## Change-by-change
### 0. Extension
`create extension if not exists pgcrypto with schema extensions`. It's normally already enabled on Supabase. No effect on data.

### 1. Pre-flight guards (no changes; may abort)
- Aborts if any of `categories, voice_sessions, notes, tasks, reminders, events, subscriptions, usage_counters` already exists **without** the expected column. That means an unknown table with the same name, which the migration must not build on.
- Aborts if `profiles.id` has no primary key/unique index, or isn't `uuid`.

### 2. `public.profiles` (existing table, if present)
| Change | Effect on existing rows |
|---|---|
| `create table if not exists` | Skipped if the table exists |
| **Add columns** `display_name text`, `ui_language text not null default 'en'`, `speech_language text not null default 'auto'`, `timezone text not null default 'UTC'`, `daily_briefing_enabled boolean not null default false`, `created_at`, `updated_at` (`add column if not exists`) | Existing rows get the default values. Postgres 17 does this without rewriting the table |
| Add **check constraints**: name ≤ 80 chars; language in allowed lists; timezone 1–64 chars | Validated against existing rows. Can only fail if FitPick already had a column with one of these names holding invalid values (the pre-flight shows the columns) |
| Add **foreign key** `profiles.id → auth.users(id) on delete cascade` **`NOT VALID`**, only if no such FK exists | Existing rows are **not checked or modified**. From then on, deleting an account deletes its profile |
| Trigger `mvl_profiles_updated_at` (keeps `updated_at` current) | Fires only on future updates |
| Existing FitPick columns (`email`, `is_pro`, `photos_used`, …) | **Kept, values unchanged**. Users can no longer update them (see security) |

### 3. New tables (created empty)
`categories`, `voice_sessions`, `notes`, `tasks`, `reminders`, `events`, `subscriptions`, `usage_counters`. Columns, keys and indexes are in `docs/ARCHITECTURE.md`. Notes:
- Every user-owned table has `user_id → auth.users on delete cascade`, so deleting an account deletes all its data.
- Child tables reference categories and voice sessions through composite keys `(id, user_id)`, so one user's record can never point at another user's category.
- Generated `tsvector` columns and GIN indexes support memory search.

### 4. Functions and triggers (all new names)
| Object | Purpose | Security |
|---|---|---|
| `mvl_set_updated_at()` | maintains `updated_at` | trigger only |
| `tasks_completed_at()` | sets or clears `completed_at` | trigger only |
| `effective_plan(uuid)` | free/premium from `subscriptions` | `SECURITY DEFINER`; **execute revoked** from clients |
| `plan_limits(text)` | free = 7 notes/month, premium = unlimited | pure |
| `enforce_note_quota()` + trigger on `notes` | blocks the 8th free note in a month; counter is never decremented | `SECURITY DEFINER`; execute revoked |
| `mvl_handle_new_user()` + trigger **`on_auth_user_created_zz_mvl`** on `auth.users` | new sign-up gets profile, free plan and 7 default categories | `SECURITY DEFINER`; `ON CONFLICT DO NOTHING`; execute revoked |
| `search_memory(text, int)` | keyword search across your own records | `SECURITY INVOKER` (RLS applies); signed-in users only |

> Why the odd trigger name: Postgres runs same-event triggers alphabetically. FitPick most likely has the Supabase template trigger `on_auth_user_created`, which inserts a profile *without* `ON CONFLICT`. If ours ran first, **every new sign-up would fail** with a duplicate-key error. I reproduced exactly that failure locally with the original name, and the rename fixes it.

### 5. Backfill (adds rows, never overwrites)
- `insert into profiles (id) select id from auth.users on conflict do nothing`: a profile for any existing user who lacks one.
- `insert into subscriptions (user_id) select id from auth.users on conflict do nothing`: a **free** plan row for every existing user.
- Default categories are **not** backfilled for existing users (only new sign-ups get them). The app works without them.

### 6. Security policy changes
| Table | Before (unknown, FitPick) | After |
|---|---|---|
| `profiles` | **All policies dropped**, whatever they were. The typical template includes "Public profiles are viewable by everyone", which exposes every user's email | owner can `SELECT`/`UPDATE` own row; no client insert/delete |
| `profiles` column rights | clients could update any column, incl. `is_pro` (the free "upgrade" hole) | clients may update only `display_name, ui_language, speech_language, timezone, daily_briefing_enabled` |
| `profiles`, `subscriptions`, `usage_counters` | `anon` had default grants | all `anon` rights revoked |
| 6 user tables | n/a (new) | RLS on; owner-only select/insert/update/delete; `anon` revoked |
| `subscriptions`, `usage_counters` | n/a (new) | owner may read; **no client writes** (service role only) |
| `outfits` | unchanged | unchanged |

## Could existing user information be affected?
- **Kept exactly:** `auth.users` (never modified), every existing `profiles` row and value, `outfits`.
- **Changed behaviour:**
  1. FitPick users can no longer read other users' profiles (if the old policy allowed it). That's the intended fix.
  2. The **FitPick app** (on `main`, apparently not deployed) would break if pointed at this database again: it updates `is_pro`/`photos_used` from the browser, which is now refused. That's also intended; it was the security hole.
  3. Existing FitPick accounts can sign in to My Voice Life with the same password. **Product/privacy question for you:** those people signed up for an outfit app. Using their accounts and emails for a different product is questionable (purpose limitation under GDPR-style rules). This is one reason I recommend a fresh project (see `docs/DEPLOYMENT.md`).

## Backups — check before approving
- **Free plan:** as far as I know, Supabase's automatic daily backups are a paid-plan feature, so a free project probably has **no restorable backup**. Check this in Dashboard → Database → Backups.
- A paused free project can usually be restored only for a limited period (90 days at the time of writing). The dashboard tells you whether restore is still possible.
- **Take your own backup before applying**, from your machine (it asks for the database password; files contain personal data, so keep them **outside** the repo):
  ```bash
  npx supabase link --project-ref <project-ref>
  ```
  ```bash
  npx supabase db dump --linked -f "%USERPROFILE%\mvl-backup\schema.sql"
  ```
  ```bash
  npx supabase db dump --linked --data-only -f "%USERPROFILE%\mvl-backup\data.sql"
  ```
  (On macOS/Linux use `~/mvl-backup/…`.) Check that both files are non-empty.

## Testing before production
1. **Done locally:** 51 checks in `npm run test:db`: fresh project (34 RLS/isolation/quota checks), simulated FitPick project (15 checks: no data loss, outfits byte-identical, FitPick trigger intact, permissive policy removed, `is_pro` locked, sign-up works with both triggers, cascade delete), conflicting table (aborts with nothing changed).
2. **Before approval (you):** run `supabase/preflight/inspect_existing_schema.sql` in the SQL editor of the target project. It runs in a **read-only transaction** (Postgres rejects writes) and returns only schema information and row *counts*. Send me the output. I'll update the FitPick fixture to match the real schema exactly and re-run the tests against it.
3. **Optional, stronger:** run Supabase locally (Docker Desktop + `npx supabase start`), restore your dump into it, and apply the migration there first. Supabase Branching does the same in the cloud, but it's a paid feature, so it needs your approval.

## How it will be applied (only after your explicit "approved")
I apply it with the Supabase migration tool, so it's recorded in the project's migration history. Then I immediately run the Supabase security advisor and `npm run check:env`, and report the results. If anything fails, the transaction rolls back and the database stays as it was.


# 2. `20261118000002_mvl_financial_controls.sql`

**Status: prepared and tested locally; NOT applied.** Approved design: `docs/FINANCIAL_CONTROL_ARCHITECTURE.md`.

## Summary for the decision
| Question | Answer |
|---|---|
| Does it delete data? | **No.** No table, column or row is dropped. It removes one trigger and two functions (logic only, see below) |
| Behaviour changes | **1. Approved:** the "7 saved notes/month" rule is removed (trigger `notes_enforce_quota`, functions `enforce_note_quota()` and `plan_limits(text)`), so manual notes become unlimited. **2.** AI requests now require a reservation (allowance, rate limits, budgets, kill switch, test mode) |
| Existing tables touched | none altered. `usage_counters` is kept with its rows but is no longer written |
| New tables (all RLS on) | `mvl_app_settings` (one row), `mvl_staff`, `mvl_plan_limits`, `mvl_plan_prices`, `mvl_fee_schedules`, `mvl_price_book`, `mvl_ai_usage`, `mvl_budget_alerts`, `mvl_operating_expenses`, `mvl_daily_activity` |
| Seed data | settings (AI `admins_only`, $2/day, $20/month, fx 0.90, VAT 0); limits free 7 captures / 15 min / 120 s / 5 per hour / 7 per day, premium 300 / 600 / 300 s / 30 / 60; prices €4.99/month and €39.99/year; Stripe fee schedules (EEA, international); Gemini 2.5 Flash and Flash-Lite prices with source URL and date |
| Personal data | `mvl_ai_usage` stores **no content** (no audio, transcript or note text), only counts, tokens and estimated cost. On account deletion its `user_id` becomes NULL (an anonymised cost record); `mvl_daily_activity` rows are deleted |
| Atomic and re-runnable | yes (tested with `--single-transaction`, applied twice) |

## Security model
| Table | Users | Admins | Edge Function |
|---|---|---|---|
| `mvl_ai_usage` | **read own rows only**; no insert, update or delete, so deleting notes or sessions can never restore an allowance | aggregates via RPC (pseudonymous 8-character hashes) | writes only through `mvl_reserve_ai_capture`, `mvl_record_ai_call`, `mvl_finish_ai_capture` (granted to `service_role` only) |
| `mvl_plan_limits`, `mvl_plan_prices` | read | update limits via RPC; cannot set 0 or NULL (no unlimited plans) | read inside reserve |
| settings, staff, price book, fees, alerts, expenses, activity | **no access** | via SECURITY DEFINER RPCs that check `mvl_is_admin()` | — |
- `anon` has no access to anything new.
- Every new function has `search_path = ''`, and execute is revoked from public, anon and authenticated before being granted precisely.
- **The staff list is managed only in the SQL editor**: there's no UI to grant admin rights, which reduces the attack surface.

## Concurrency and "never exceed the budget"
- `mvl_reserve_ai_capture` locks the settings row (`FOR UPDATE`), so reservations are processed one at a time.
- Each reservation holds the **worst-case cost**: exact audio length + maximum text input + 2 × the output cap (the Edge Function sets `maxOutputTokens` and turns thinking off). The final cost is corrected from Gemini's real token counts.
- Abandoned reservations expire after 15 minutes and keep their worst-case cost.
- **Tested:** two sessions racing for the last free capture, and for the last bit of budget: exactly one wins each time. The test was confirmed to fail when the lock is removed.

## Evidence
`npm run test:db`: **130 checks pass**: 31 core RLS/isolation checks (the note-quota checks were replaced by an unlimited-notes check), 79 financial-control checks, 3 concurrency checks, 15 legacy-upgrade checks and 2 guard checks.

## Rollback (if ever needed, after approval)
Drop the `mvl_*` functions and tables, and re-create the note-quota trigger from migration 1. No user content is involved. I'll prepare it as a separate file if you ask.

---

# 3. `20261119000001_mvl_openai_pricing.sql` — OpenAI per-minute pricing

**Status:** written and tested locally; **not applied**. Applying it needs the owner's explicit approval.

| Question | Answer |
|---|---|
| Does it delete data? | **No.** It adds one column, two price rows and one function, and replaces one `mvl_` function |
| Requires | migration 2. Its pre-flight aborts with a clear message otherwise |
| Changes | `mvl_price_book.audio_usd_per_minute` (default 0, must be ≥ 0). Rows `openai / gpt-transcribe+gpt-6-luna` ($0.0045/min, $0.10/$0.50 per 1M tokens) and `openai / gpt-6-luna` (text only), with source URLs and date 2026-11-19 |
| Replaced function | `mvl_capture_cost_ceiling`: the worst-case hold now adds `ceil(seconds)/60 × per-minute rate`. The existing token terms are unchanged, so Gemini rows keep their old ceilings |
| New function | `mvl_record_ai_transcription(reservation, seconds)`: books `ceil(seconds)/60 × rate` and sets the capture's `audio_seconds` to the billed length. It rejects negative or absurd durations and closed reservations. **Service role only** |
| Gemini rows | left as they are (inert: no code requests them). They are historical, and the existing financial tests use them as generic fixtures |
| Tests | `supabase/tests/openai_multilingual_test.sql`: price rows, ceilings ($0.007198 for 60 s), recording maths, closed-reservation and negative-duration refusals, unknown model fails closed, non-staff refused, users can't call the RPC, free allowance enforced |

# 4. `20261119000002_mvl_multilingual.sql` — multilingual profiles

**Status:** written and tested locally; **not applied**.

| Question | Answer |
|---|---|
| Does it delete data? | **No.** It drops two of *our own* check constraints (fixed `en/fr/rw` lists) and replaces them with code-format checks. No row is changed, except the carry-over below |
| New column | `profiles.speech_languages text[]` (default empty, at most 3, each a valid ISO 639 code via `mvl_valid_language_codes`). Owners may update it (column grant); RLS unchanged |
| Data carry-over | users who had picked one spoken language get it copied into `speech_languages` |
| Compatibility | `speech_language` is kept (`'auto'` or the first spoken language) for older clients |
| Tests | any code accepted for the interface language (`sw`, `zh-cn`); more than 3, or invalid codes, rejected; a user can't change another user's languages; notes keep their language; search finds Kinyarwanda, Chinese (no spaces) and accented French text. The old "invalid language rejected" check now uses a really invalid code |
| Atomic and re-runnable | yes: the whole suite applies every migration twice, in single transactions |
