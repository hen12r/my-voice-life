# CLAUDE.md — My Voice Life

AI personal assistant: speak once → reviewed tasks, reminders, events and notes → searchable personal memory.
Tagline: *Your voice. Your ideas. Your organised life.*

## Stack
- **Frontend:** Vite 6 + React 19 + TypeScript (strict) + Tailwind CSS v4 (`@tailwindcss/vite`) + React Router 7 + lucide-react. Source in `src/`.
- **Backend:** Supabase (Postgres + Auth + RLS) and Deno Edge Functions in `supabase/functions/`.
- **AI:** Gemini via REST, called **only** from the `process-voice` Edge Function (key = Supabase secret `GEMINI_API_KEY`).

## Commands
- `npm run dev` — dev server on :3000 (needs `.env.local`, see `.env.example`)
- `npm run typecheck` / `npm test` (Vitest) / `npm run build`
- `npm run test:db` — applies all migrations to a throwaway local Postgres with a Supabase shim and runs `supabase/tests/rls_test.sql`. Needs `PGHOST/PGPORT/PGUSER` pointing at a **local** Postgres. Never point it at production.
- `npx deno@2.1.4 check supabase/functions/*/index.ts` — type-check Edge Functions.
- `npm run test:functions` — Deno orchestration tests for `process-voice` (fakes for Gemini/Supabase; proves reserve → paid call → record → finish ordering).
- CI: `.github/workflows/ci.yml` runs all of the above plus `test:db` on every push/PR. Keep it green; never skip or disable a test to pass it.
- `npm run check:env [-- --origin <url>]` — validates `.env.local` and probes Supabase (auth health, anon access blocked, function + CORS). Prints masked values only.
- `node scripts/eval/transcribe.mjs` / `score.mjs` — Kinyarwanda/STT evaluation (see `docs/kinyarwanda/TEST_PLAN.md`); data lives in git-ignored `eval-data/`.

## Non-negotiable rules
1. **No secrets in the browser.** Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` may be `VITE_*`. (Vercel's own injected `VITE_VERCEL_*` build metadata is tolerated by the guard, but still secret-checked; never define such variables yourself.) AI keys and the service-role key live only in Edge Function secrets. Never commit `.env*` (except `.env.example`).
2. **RLS on every user-owned table**, owner-only policies using `(select auth.uid()) = user_id`. Never disable RLS to fix a bug. Add a case to `supabase/tests/rls_test.sql` for every new table.
3. **Entitlements and AI spending are server-side.** `subscriptions` and every `mvl_*` financial table are writable only through SECURITY DEFINER functions (accounting RPCs granted to the service role; admin RPCs that check `mvl_is_admin()`). Every AI call must first obtain `mvl_reserve_ai_capture()` (allowance, rate limits, budgets, kill switch, test mode) and record real token usage with `mvl_record_ai_call()`. No plan may be unlimited. The client never decides limits; it only displays `mvl_my_usage()`.
4. **Nothing AI-generated is saved without user confirmation.** `process-voice` returns proposals; the client commits only accepted items. All model output passes `validateExtraction()` (`supabase/functions/_shared/extraction.ts`).
5. **Never invent dates.** Ambiguous dates are cleared and flagged; reminders/events cannot be saved without a date.
6. **Audio is never stored.** It is processed in memory by the Edge Function. Transcripts are stored (they are the memory).
7. **No fake features.** No decorative buttons, no fake AI output, no claims of support that are untested (Kinyarwanda is "experimental" until tested with real speakers).
8. Migrations are additive/idempotent SQL files in `supabase/migrations/`. Applying to the real project requires the owner's explicit approval.
9. Do not merge to `main` or deploy without the owner's approval. `main` is the production branch; work happens on feature branches with draft PRs.
10. **This repository (`hen12r/my-voice-life`) contains only My Voice Life.** It was migrated with full history from `hen12r/-hen12r` (PR #3), which also hosts FitPick and **Photosentry** (branch `claude/amazing-tesla-jorf1p`, Vercel project `photosentry`, Supabase project `photosentry`). Never push My Voice Life work to `hen12r/-hen12r`, and never modify Photosentry's branches, Vercel project or Supabase project.
11. New SQL objects get collision-proof names (`mvl_` prefix or similar) — never `create or replace` a function/trigger name a legacy schema might already use.
12. **Financial figures are labelled.** Anything not directly recorded is shown as *projected* or *estimate*; contribution is never called profit. Admin views show aggregates and pseudonymous IDs only, never note or transcript content.
13. AI stays in `admins_only` mode until the owner approves paid Gemini billing and the privacy review. Prices and limits live in tables (`mvl_price_book`, `mvl_plan_limits`, `mvl_app_settings`), not in code.

## Layout
```
src/
  auth/AuthProvider.tsx   session + profile context
  components/             AppShell (nav), ui.tsx (design-system primitives)
  lib/                    supabase client, api (data access + commit logic), dates (tz math), i18n (en/fr), types
  pages/                  Landing, Auth (login/register/forgot/reset), Dashboard, Capture, Notes, Tasks, Schedule, Memory, Settings, Admin (staff-only usage + finance)
  voice/useRecorder.ts    MediaRecorder hook (in-memory only)
supabase/
  migrations/             versioned SQL
  functions/_shared/      extraction.ts, transcription.ts, cors.ts, usage.ts (pure, shared & tested), http.ts (Deno-only)
  functions/process-voice handler.ts (logic, injectable deps) + index.ts (wiring) + handler.test.ts (Deno)
  functions/delete-account
  tests/                  shim + RLS test suite
  preflight/              read-only inspection SQL to run before approving migrations
  tests/financial_test.sql  allowance/budget/kill-switch/dashboard checks (+ race test in scripts/test-db.sh)
docs/                     ARCHITECTURE, DEPLOYMENT, MIGRATION_REVIEW, PRODUCT, ROADMAP, SETUP, kinyarwanda/ (test plan, prompts, sheet)
scripts/                  test-db.sh, check-env.mjs, env-guard.mjs (build secret guard), eval/ (WER/CER tooling)
vercel.json               build settings, SPA rewrite, security headers (CSP)
```

## Conventions
- Shared logic that both Deno and the browser need goes in `supabase/functions/_shared/*.ts` with **no** Deno/browser APIs.
- UI strings go through `useI18n().t()`; add keys to both `en` and `fr` in `src/lib/i18n.tsx`. Kinyarwanda UI strings require native-speaker review — do not machine-generate them.
- Store instants as `timestamptz` (UTC) and the user's IANA zone alongside; convert with `src/lib/dates.ts`.
- Keep `docs/ROADMAP.md` honest: "done" means implemented **and** tested.
