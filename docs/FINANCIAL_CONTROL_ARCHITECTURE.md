# Financial control architecture (PROPOSAL)

**Status: approved 2026-11-18 and implemented locally** in `supabase/migrations/20261118000002_mvl_financial_controls.sql`, `supabase/functions/process-voice`, `src/pages/Admin.tsx`. **Not applied to any live database.** The SQL sketch below is the design; the migration file is authoritative (it adds `mvl_staff` with admin/tester roles, worst-case cost holds and reservation expiry). It extends the existing schema additively, following the same rules as the core migration: owner-only RLS, service-role-only writes for money and usage data, collision-proof names, tested before review.

## Goals → design
| Requirement | Design |
|---|---|
| Record AI usage per user; track voice minutes, requests and tokens | append-only **`mvl_ai_usage`** ledger, one row per Gemini call, with **real** token counts from Gemini's `usageMetadata` (audio, text, output and thinking tokens) |
| Estimated AI cost | cost = recorded tokens × **`mvl_price_book`** rate valid at that time. Stored on each row and always labelled *estimated* (the provider's invoice is the truth) |
| Monthly limits for free and premium; no unlimited usage | **`mvl_plan_limits`** table: free 7 AI captures/month; premium fair-use cap (proposal: 300 captures, 600 audio minutes). **Every plan has a finite limit** (`NOT NULL` + check constraint) |
| Rate limiting | per-user per-hour and per-day limits counted **from the ledger** (users can't delete it), plus a global daily budget |
| Prevent unlimited requests | **atomic reservation** in the database *before* calling Gemini; refused requests never reach the provider |
| Disable expensive AI features temporarily | **`mvl_app_settings`**: `ai_mode = 'on' \| 'admins_only' \| 'off'` with a user-facing message. Manual notes and tasks keep working |
| Alerts near budget | thresholds (50/80/100%) create **`mvl_budget_alerts`** rows, shown in the admin dashboard; optional email later (needs an email provider) |
| Admin usage dashboard + financial dashboard | admin-only RPCs returning **aggregates only** (no note content, no transcripts) |
| Track monthly operating expenses | **`mvl_operating_expenses`**: admin-entered rows, each marked `actual` (from an invoice) or `estimate` |
| Revenue, Stripe fees, contribution | from **`mvl_plan_prices`** × subscriptions (list prices; **projected** until real payments exist) and **`mvl_fee_schedules`**. Contribution labelled *estimated, not profit* |
| API keys never in frontend | unchanged: Gemini key in Supabase secrets; the ledger is written by the Edge Function with the service role (auto-provided to Edge Functions, never to the browser) |

## Request flow (process-voice, after the change)
```
browser ──JWT──▶ process-voice
  1. verify user (as today)
  2. read mvl_app_settings ─ ai_mode off? → 503 ai_paused   · admins_only & not admin? → 403 ai_test_mode
  3. size check by plan (free ≈2 min, premium ≈5 min of opus audio) → 413
  4. rpc mvl_reserve_ai_capture(user, est_seconds)        [service role, one transaction, row lock]
        checks: plan monthly captures + audio minutes · per-hour/per-day caps · global daily/monthly budget
        on OK: inserts a 'reserved' row in mvl_ai_usage and returns its id
        on refuse: returns reason → 429 quota_exceeded / rate_limited / 503 budget_reached
  5. Gemini transcribe (thinking budget 0) → mvl_record_ai_call(reservation, usageMetadata, status)
  6. Gemini extract   (thinking budget 0) → mvl_record_ai_call(...)
  7. any provider error → the reservation is marked 'failed' (it still counts toward rate limits, so retry storms can't run up costs; failed calls don't use up the monthly quota)
  8. response includes remaining quota → UI shows "5 of 7 AI voice notes left this month"
```

## Proposed database changes (new migration, additive)
```sql
-- Settings (single row). Admin-editable via RPC only.
create table public.mvl_app_settings (
  id boolean primary key default true check (id),
  ai_mode text not null default 'admins_only' check (ai_mode in ('on','admins_only','off')),
  ai_paused_message text,
  daily_ai_budget_usd numeric(10,2) not null default 2.00,
  monthly_ai_budget_usd numeric(10,2) not null default 20.00,
  alert_thresholds numeric[] not null default '{0.5,0.8,1.0}',
  fx_usd_to_eur numeric(10,4) not null default 0.90,   -- estimate, set by admin
  vat_rate numeric(5,4) not null default 0,            -- for net revenue estimates
  prices_include_vat boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.mvl_admins (user_id uuid primary key references auth.users on delete cascade);

-- Finite limits per plan (no NULL = no unlimited).
create table public.mvl_plan_limits (
  plan text primary key check (plan in ('free','premium')),
  ai_captures_per_month integer not null check (ai_captures_per_month > 0),
  audio_minutes_per_month integer not null check (audio_minutes_per_month > 0),
  max_capture_seconds integer not null check (max_capture_seconds between 10 and 600),
  captures_per_hour integer not null,
  captures_per_day integer not null
);
-- seed: free (7, 15, 120, 5, 7) · premium (300, 600, 300, 30, 60)   ← owner to confirm

create table public.mvl_plan_prices (
  id bigserial primary key, plan text not null, billing_interval text not null check (billing_interval in ('month','year')),
  amount_cents integer not null, currency text not null default 'EUR', active_from date not null, active_to date
);
-- seed: premium/month 499 EUR · premium/year 3999 EUR

create table public.mvl_price_book (            -- AI provider prices, per 1M tokens
  id bigserial primary key, provider text not null, model text not null,
  audio_in_usd numeric(10,4) not null, text_in_usd numeric(10,4) not null, output_usd numeric(10,4) not null,
  effective_from date not null, effective_to date, source_url text not null
);
-- seed: gemini-2.5-flash 1.00/0.30/2.50 · gemini-2.5-flash-lite 0.30/0.10/0.40 (from ai.google.dev, 2026-11-18)

create table public.mvl_fee_schedules (         -- payment fee assumptions
  id bigserial primary key, provider text not null, card_region text not null,
  pct numeric(6,4) not null, fixed_cents integer not null, billing_pct numeric(6,4) not null default 0,
  currency text not null default 'EUR', effective_from date not null
);
-- seed: stripe eea 0.015/25/0.007 · stripe international 0.0315/25/0.007

-- Append-only AI usage ledger. Contains NO content (no audio, no transcript).
create table public.mvl_ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete set null,   -- kept anonymised after account deletion for cost accounting
  voice_session_id uuid,                                   -- no FK, so deleting a session keeps the cost record
  occurred_at timestamptz not null default now(),
  plan text not null,
  status text not null check (status in ('reserved','ok','failed','refused')),
  refusal_reason text,
  feature text check (feature in ('capture','transcribe','extract')),
  provider text, model text,
  audio_seconds numeric(8,2), audio_tokens integer, text_in_tokens integer, output_tokens integer, thinking_tokens integer,
  price_book_id bigint references public.mvl_price_book,
  est_cost_usd numeric(12,6)                              -- ESTIMATE = tokens × price book
);
create index on public.mvl_ai_usage (user_id, occurred_at desc);
create index on public.mvl_ai_usage (occurred_at);

create table public.mvl_budget_alerts (
  id bigserial primary key, period text not null check (period in ('day','month')), period_start date not null,
  threshold numeric not null, spend_usd numeric(12,4) not null, created_at timestamptz not null default now(),
  unique (period, period_start, threshold)
);

create table public.mvl_operating_expenses (
  id bigserial primary key, month date not null, service text not null,
  category text not null check (category in ('hosting','database','ai','payments','email','domain','other')),
  amount numeric(12,2) not null, currency text not null default 'USD',
  kind text not null check (kind in ('actual','estimate')), note text, created_by uuid references auth.users on delete set null
);

-- Daily activity marker for honest monthly active user (MAU) counts (one tiny row per user per active day).
create table public.mvl_daily_activity (user_id uuid references auth.users on delete cascade, day date, primary key (user_id, day));
```
**Security:**
- RLS on every table.
- Users can **read only their own** `mvl_ai_usage` rows and the plan limits. They can **write none** of these tables.
- `mvl_daily_activity` is written only through `mvl_touch_activity()` (security definer: own row, today only).
- Settings, admins, prices, fees, expenses and alerts have **no client access**. Admin reads and writes go through `SECURITY DEFINER` RPCs that check `mvl_is_admin()`.
- Admin RPCs return **aggregates only**.

**Functions (all `mvl_`-prefixed):** `mvl_is_admin()`, `mvl_reserve_ai_capture()`, `mvl_record_ai_call()`, `mvl_release_reservation()`, `mvl_touch_activity()`, `mvl_admin_usage_summary(month)`, `mvl_admin_finance_summary(month)`, `mvl_admin_update_settings(...)`, `mvl_admin_add_expense(...)`.

## Changes to existing behaviour (need your explicit OK)
1. **The free limit moves from "7 saved notes/month" to "7 AI voice notes/month".** The existing `enforce_note_quota` trigger on `notes` would be removed, making manual notes unlimited (they cost nothing). This is the only part of existing functionality that changes; every other feature keeps working.
2. Typed text sent to "Organise this" also uses AI, so it **counts as an AI capture**.
3. New error states in the UI: `quota_exceeded`, `ai_paused`, `ai_test_mode`, `budget_reached`. Each one offers "save as a manual note instead".
4. **Default `ai_mode = 'admins_only'`** while on the free Gemini tier, so real users' data never reaches the free tier (which may use content to improve Google's products).

## Dashboards (admin only, route `/app/admin`)
**Usage:** AI captures today, this month and per day (chart); audio minutes; tokens split by audio, text, output and thinking; failure and refusal rates; top 10 users by estimated cost, shown as anonymised IDs; users at their limit; kill switch and budgets.

**Finance (month view).** Every figure carries a source label:
| Figure | Source | Label |
|---|---|---|
| Monthly active users | `mvl_daily_activity` | recorded |
| Free / premium users | `subscriptions` | recorded |
| Subscription revenue | premium subscriptions × `mvl_plan_prices` | **projected (no payments active)**; becomes recorded once Stripe webhooks exist |
| Revenue net of VAT | revenue × settings VAT rate | estimate |
| Stripe fees | revenue × `mvl_fee_schedules` | estimate |
| AI costs | sum of `mvl_ai_usage.est_cost_usd` | estimate from recorded usage |
| Hosting and other costs | `mvl_operating_expenses` | actual or estimate, per row |
| **Estimated contribution** | net revenue − fees − AI − operating expenses | **estimate, not profit** (excludes income tax, refunds, salaries) |

## Tests (before asking for approval to apply)
- **DB:** quota enforced at exactly the 7th/8th capture; users can't read others' usage or write any ledger, settings, price or expense table; reservation is atomic under concurrent requests; failed calls count for rate limits but not quota; budget threshold creates one alert, not duplicates; kill switch blocks; `admins_only` blocks non-admins; account deletion anonymises usage rows and removes activity rows; no plan can be set to unlimited.
- **Unit:** cost calculation from `usageMetadata` against the price book; fee and contribution maths; dashboard labels.
- **Edge Function:** `deno check`; error mapping for each refusal reason.
- **Regression:** the existing 51 database checks and 45 unit tests stay green, except the note-quota checks, which change with decision 1 above.

## Effort and order
1. Migration + DB tests (largest part)
2. Edge Function: reservation, recording, thinking off, kill switch
3. UI: remaining-quota display, error states
4. Admin dashboards
5. Docs and roadmap

All of this is local work. Applying the migration to a real database still needs your separate approval.
