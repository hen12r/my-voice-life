# Work log

A record of completed and unfinished work. Newest first. "Verified" means a test or tool output shows it; anything else is labelled.

## 2026-11-20 — OpenAI integration readiness (branch `claude/stripe-billing`)
Audit of `process-voice` against developers.openai.com: the `gpt-transcribe` (`/v1/audio/transcriptions`, multiple language hints) and `gpt-6-luna` (`/v1/responses`, `reasoning.effort: none`, Structured Outputs) model IDs and options exist as used. No key handled, no deploy, no migration, no secret changed.

| Change | Why | Evidence |
|---|---|---|
| `_shared/secrets.ts`: `redactSecrets`, used on every OpenAI error text and on the language-hint retry warning | OpenAI's 401 body echoes a masked key fragment, which went into Supabase logs, and the retry warning logged the raw body | Vitest `secrets.test.ts`; Deno test "wrong or revoked key (401)…": with redaction removed, it **fails** (mutation check) |
| `normaliseApiKey` in `index.ts` | A key pasted with a trailing line break or quotes made every request throw a generic error, and booked the recording as spent | Vitest cases for spaces, quotes, inner whitespace, and warnings that never include the key |
| OpenAI 401/403 → `ai_not_configured` plus a setup hint in the log; 404 → a model hint | A wrong, revoked or model-restricted key used to show as a generic `ai_unavailable` with no clue | 2 new Deno tests (not billed when refused; the browser gets no configuration details) |
| Test: the key goes only to `api.openai.com` and is never in a response | Locks in the existing behaviour | Deno test |
| `docs/OPENAI_SETUP.md` rewritten (current live status, key handling, setup, check, troubleshooting) | It still said the function was not deployed | — |

Tests: Vitest 147/147, Deno `process-voice` 30/30, all function tests and type checks pass. **All OpenAI replies in tests are fakes**; no request has reached OpenAI.

**Still blocked (needs an adult):** `OPENAI_API_KEY` in Supabase Edge Function secrets (re-checked: "No custom secrets created"). Then a live capture test (`docs/OPENAI_SETUP.md` §3). Before production: `ALLOWED_ORIGINS`.

## 2026-11-18/19 — autonomous cloud session (branch `claude/autonomous-hardening`)
Run in Claude Code **cloud** (session environment `anthropic_cloud`), with the owner's computer off. Based on PR #1 head `feaa738`.

### Completed (all pushed)
| Commit | Change | Evidence |
|---|---|---|
| `743b216` | Pre-flight script rewritten as one read-only SELECT returning a JSON report; works on a brand-new project | ran on the real empty `my-voice-life` project (read-only) and on the local simulated FitPick DB |
| `4fd850b` | `process-voice` split into `handler.ts` (logic, injectable deps) + `index.ts` (wiring); 16 Deno orchestration tests; voice capture measuring 0 s is refused before reserving | 16/16 pass; ignoring refusals makes 3 tests fail (mutation check) |
| `5b4fcd1` | Review fixes: authenticate before revealing `ai_not_configured`; en/fr messages for 5 error codes + test that every backend code is translated; "Re-organise" disabled when AI blocked; admin link in Settings (mobile) | 17/17 Deno, 56/56 unit |
| `535b963` | GitHub Actions CI: typecheck, unit, build + secret-guard self-test, Deno check + tests, full DB suite on Postgres 16 | **CI run #1 succeeded on GitHub** (all 13 steps) |
| `a46e10a` | DB harness stops at the first failing migration (found in CI's DB log); guard check covers `mvl_*` tables; CI actions bumped to v5 | 130/130 DB checks |
| `8a0f1c1` | Vitest 5.1.1 (fixes 2 critical + 1 moderate advisories in dev tooling; production deps had 0) | `npm audit`: 0 vulnerabilities; 56/56 unit; build OK |

### Skipped because they need the owner's approval
- Applying migrations to the `my-voice-life` Supabase project (approval pending).
- Creating the Vercel project, deploying, enabling Gemini billing or adding a key, Stripe, merging PR #1, closing PR #3.

### Blockers (need the owner)
- No Vercel project → no preview deployment to verify.
- Migrations not applied → app can't be tested end-to-end against Supabase.
- No Gemini key → the real AI path is untested (orchestration is tested with fakes).

## 2026-11-19 — Remote setup (owner-approved)
- PR #2 merged into PR #1's branch (`d74e470`); CI green.
- **Migrations applied to Supabase `my-voice-life` (`nwglzabnezhmxfyuxhmg`)**:
  - Both files were applied unchanged, via the Supabase connector.
  - Migration history was repaired to versions `20261118000001` / `20261118000002`, so a later `supabase db push` applies nothing new.
  - Remote schema fingerprint matches a local build from the files: all 19 tables, 31 policies, columns, constraints, indexes, triggers, seed rows, and every function and grant this project created.
  - The only extra remote function is Supabase's own `rls_auto_enable`.
  - RLS is on everywhere; `ai_mode = admins_only`; budgets are $2/day and $20/month; 0 users and 0 staff.
  - The security advisor reports only intended items: deny-all tables reached through RPCs, and admin RPCs that check `mvl_is_admin()`.
- **Vercel project `my-voice-life`** was created and linked to `hen12r/my-voice-life`:
  - settings: Vite, `npm ci` / `npm run build` / `dist`, Node 22.x;
  - environment variables: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`;
  - Vercel Authentication is on.
- **Deployment incident:** a first API-triggered build was classified `production` by Vercel even though no target was sent. It was cancelled within seconds, before it was ready, so nothing was served. Previews now come from Git pushes to this branch.
- Not done yet: Edge Functions deployment, Gemini key, admin account, Supabase Auth URL configuration.

## 2026-11-19 — OpenAI voice pipeline, microphone fixes, multilingual, Google sign-in (branch `claude/openai-voice`)
- **Root cause of the "broken" microphone** (audit): no Edge Function deployed, no AI key, and the mic is disabled by design for accounts that are not staff while AI is `admins_only` (0 staff rows). The Gemini code itself was never live.
- **OpenAI provider** behind an `AiProvider` interface. `gpt-transcribe` for speech, `gpt-6-luna` through the Responses API with a strict JSON schema for extraction. Models and prices were verified on developers.openai.com. All Gemini code was removed.
- **Cost control without a free length probe:** the server reads the real duration from WebM/Ogg/MP4 before reserving; the client's claim can only lengthen it. Billed seconds are recorded with the new `mvl_record_ai_transcription`. If a call times out, the measured length is booked.
- **Migrations 3–4** (local only):
  - per-minute pricing;
  - multilingual profiles (`speech_languages`, code-format checks).
- **Microphone:** specific messages for a non-secure page and for a microphone in use or blocked by the system (they were "Something went wrong"); a retry when the device rejects the constraints. The allowance bar is hidden when AI isn't available (it contradicted the test-mode notice).
- **Multilingual:** 24-language registry with honest interface and voice statuses (none verified); Settings picker for up to 3 spoken languages; locale and direction handling; the evaluation script ported to OpenAI.
- **Google sign-in button** plus a setup guide; email and password unchanged.
- **Tests:**
  - 160 DB checks (+30);
  - 99 unit tests (+43);
  - 27 Deno orchestration tests (+10);
  - browser end-to-end runs: tester success, mic denied, mic in use, non-staff, provider busy, Settings languages, Google redirect.
- **Not done (needs the owner or adult):** OpenAI account, credits and key; migrations; function deploy; tester row; Google credentials; real-phone and native-speaker tests.

## 2026-11-19 — Auth fixes, signature microphone, beta readiness (branch `claude/openai-voice`)
- `34d6d16`: actionable sign-in errors (14 codes, en/fr), resend confirmation, existing-email detection, expired-link handling, password show/hide, mobile sign-out. 8 browser scenarios (mocked).
- `5ceccf5`: signature microphone. The orb and waveform follow the real AnalyserNode level, proven with a fake-microphone file (levels 0/0.29/0.05/0). Honest stages from real XHR upload progress. Animated review cards with edit, reject and undo. Optional sound cues; reduced motion.
- `5bad18a`: task completion feedback; PWA PNG icons; every page checked at 360 px and desktop with 0 console errors.
- Login diagnosis (read-only auth logs): two accounts, one unconfirmed. No code bug; no account changed.
- Reports: `PRIVATE_BETA_READINESS_REPORT.md`, `APPROVAL_CHECKLIST.md`.
- Tests: 105 unit, 27 Deno, 160 DB; typecheck and build pass.
- **Awaiting approval:** migrations 3–4, tester row, function deploy, OpenAI key (adult), Google credentials.

## 2026-11-20 — Stripe subscriptions, test mode (branch `claude/stripe-billing`, stacked on `claude/openai-voice`)
- Inspected the architecture first. `subscriptions`, owner-read RLS, `effective_plan()` (active/trialing within the period) and table-driven limits already existed, so what was added is the sync path, not a new entitlement model.
- **Migration 5** (local only): Stripe statuses, `mvl_stripe_events` idempotency ledger, `mvl_billing_link_customer`, `mvl_billing_apply_subscription` (service role only). Review: `docs/MIGRATION_5_BILLING_REVIEW.md`. Tested rollback.
- **Edge Functions:** `billing` (public prices read from Stripe; checkout; portal), `stripe-webhook` (verified, re-fetches, idempotent), `delete-account` (cancels the subscription first). Test-mode lock: live keys refused without `STRIPE_LIVE_MODE_APPROVED=true`.
- **Frontend:** Pricing page, `/app/billing/success` (waits for the server), Settings plan card (renewal/end date, failed payment, Manage subscription), en/fr.
- Stripe facts checked on docs.stripe.com: signature scheme, item-level billing periods since basil, invoice→subscription path, current API version, endpoints and parameters.
- **Tests:** DB billing suite and rollback; 41 new Deno tests (68 in total); Vitest 134+; 11 mocked browser scenarios; mutation checks.
- **Not done:** no Stripe account was created or accessed; nothing deployed; no migration applied; no secret set.

## 2026-11-20 — Owner-approved changes applied to Supabase `nwglzabnezhmxfyuxhmg`
The owner explicitly approved all four steps ("Attaque", then selected each one).
- **Migrations 3, 4 and 5 applied verbatim.** History aligned to `20261119000001`, `20261119000002` and `20261120000001`.
  - Verified read-only: the 2 OpenAI price rows; the new columns and constraints; none of the elevated functions can be run by visitors or signed-in users; profiles unchanged (spoken languages `[]`); notes 2 and tasks 1 on the owner's account; 2 subscription rows unchanged; ledger empty with RLS on.
  - Security advisor: only the intended deny-all and admin-RPC notes.
- **Tester access:** 1 row in `mvl_staff` (role `tester`) for the confirmed owner account. Checked as that user: `is_staff` true, `is_admin` false, `mvl_is_admin()` false. `ai_mode` stays `admins_only`.
- **Edge Functions deployed, version 1, all ACTIVE:**
  - `process-voice`: JWT check on;
  - `billing`: JWT check off by design; checks the user itself;
  - `stripe-webhook`: JWT check off by design; checks Stripe's signature;
  - `delete-account`: JWT check on.
- **No secrets added.** Without them: voice answers `ai_not_configured`, billing reports "not configured", the webhook returns 503.
- **Not verified:** HTTP calls to the live functions. This session's network proxy blocks the Supabase host.
- **Still needed:**
  - `ALLOWED_ORIGINS` (the preview origin) for browser calls to the functions;
  - an OpenAI key (adult);
  - Stripe test secrets (adult).

## Earlier milestones
See `docs/ROADMAP.md` (status table with evidence) and the PR #1 description.

## 2026-11-21 — Google sign-in diagnosis + launch preparation
- **Google sign-in, exact cause:** live auth logs show `400 provider is not enabled`; the Google provider is disabled in Supabase. Code now hides the button while disabled, and handles redirect/cancel cleanly (`src/auth/providers.ts` + tests). Owner steps in `docs/GOOGLE_OAUTH_SETUP.md`. **Not fixed until a real Google login succeeds.**
- **Legal drafts:** `/privacy` and `/terms` (no invented identity; owner placeholders marked), linked from landing, register, pricing and settings; capture disclosure names OpenAI.
- **UX:** small tap targets enlarged; 14 pages × 4 widths mock-audited with no overflow and no console errors.
- **Checks:** typecheck, 151 Vitest, build, deno check, 71 Deno tests, test:db: all green.
- **Live state (read-only):** 2 users, email identities only, 0 AI usage, 0 Stripe events, `admins_only`, 0 tables without RLS. No production change made.
- Report: `docs/LAUNCH_READINESS_REPORT.md`.

## 2026-11-21 (later) — first tests against the REAL preview and backend
- **How:** the session network was limited to the preview and Supabase hosts (new personal environment "My Voice Life", approved). A temporary Vercel share link was used to pass Deployment Protection; the link was not published. Headless Chromium; **Claude in Chrome was not available**.
- **Live results:**
  - 9 public pages at 360/390/768/1366 px: no overflow, no console errors.
  - `/app` redirects to `/login`.
  - The Google button is hidden (the provider is still off).
  - A wrong password shows a clear message.
  - Registration validates email and password in the browser.
  - Pricing loads the real `billing` function (200) and honestly says Premium is unavailable.
  - CSP, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy: microphone=(self)` and HSTS are present.
  - CORS allows the preview origin for all functions; `process-voice` without a token returns 401; the webhook with a bad signature returns 503 (not configured).
- **Fixed (code, not yet deployed):** a disallowed origin was sent back the raw pattern `https://my-voice-life-*-henry7.vercel.app` as `Access-Control-Allow-Origin`. That was harmless (browsers reject it) but wrong. Now the header is omitted (`allowOriginHeader`, + test). It goes live only after an approved redeploy of the functions.
- **Not tested live:** anything behind sign-in (no test account available; see the report).

## 2026-11-21 ~11:40 UTC — function redeploy (owner-approved), paused after delete-account
- **Before deploying:** the live code was byte-compared with git (read-only).
  - `delete-account` v2 and `billing` v2 = commit `d84c1b8`.
  - `process-voice` v2 = `d84c1b8`, 9 of 10 files identical. `extraction.ts` differs only in encoding (`​` stored as a literal zero-width space); the JavaScript is equivalent.
- **Deployed: `delete-account` → v3, ACTIVE, verify_jwt=true** (code at `3ecbc81`: the CORS fallback fix).
  - Verified live: preview origin allowed (200 + exact origin); `https://evil.example` gets no Allow-Origin; a POST without a token returns 401.
  - Rollback source: `d84c1b8`.
- **Paused by the owner:** `billing` (v2) and `process-voice` (v2) were NOT deployed. They wait for approval from the responsible adult who manages Supabase.
- `stripe-webhook` (v1) untouched.
- No secrets, migrations, data, roles, `ai_mode`, Google, Stripe, Vercel or `main` changes.
- **Compatibility of the pending `process-voice` (read-only checks):**
  - the 4 accounting RPCs exist with the exact argument names, service_role only;
  - price-book rows for the default OpenAI models exist;
  - no migration needed;
  - the frontend already handles `ai_not_configured`.
- Checklist: `docs/PROCESS_VOICE_DEPLOY_CHECKLIST.md`.

## 2026-11-21 — testing checklists adapted to desktop
- Owner tests on a computer, not a phone. `docs/PHONE_TEST_CHECKLIST.md` was replaced by `docs/DESKTOP_TEST_CHECKLIST.md`: 21 steps covering the sidebar layout, narrow window, 200% zoom, data persistence (F5 and reopening), keyboard (Tab/Esc), language, pricing and legal pages, microphone allow/block via the address bar, and sign-out errors.
- The real voice-test checklist (`docs/PROCESS_VOICE_DEPLOY_CHECKLIST.md`) was adapted for desktop browsers: DevTools Offline replaces airplane mode; the address-bar permission replaces phone settings. It now states that mocks do not prove the OpenAI integration: only the real tests 2, 3, 5, 6, 8 and 14 do.
- Real phones remain untested and are listed as such. Nothing deployed.

## 2026-11-21 — Free/Plus/Pro subscriptions + Bring Your Own AI (built and tested offline; nothing deployed)
- Owner decisions: pure BYOAI (no AI credits in any plan); key storage built now (OpenAI only); Pro = bigger limits only; Free keeps reminders/events with caps. Objections recorded in `docs/SUBSCRIPTIONS_BYOAI_REPORT.md`.
- Migration 6 (local + tests only): plans free/plus/pro, configurable caps (triggers), 7-day payment grace, webhook apply v2, BYOAI key storage in Supabase Vault, BYOAI usage and rate limits, `byoai_mode` (default admins_only). Rollback + pre-flight (live, read-only: 0 user rows would change).
- Functions: billing (checkout per plan, change_plan, invoices), stripe-webhook (plan from the price allow-list), new ai-connections, process-voice BYOAI routing.
- Frontend: Pricing (3 plans + "AI billed separately" notice), new Billing page, "Your AI provider" card, Capture states, plan-limit messages.
- Tests: all DB suites, 100 function tests, 167 unit tests, 8 mocked browser scenarios at 4 widths. **No real Stripe test-mode run and no real OpenAI run yet** (no account / key).
- Docs: `STRIPE_SETUP.md` rewritten, new `BYOAI_SECURITY.md`, legal drafts updated, report `SUBSCRIPTIONS_BYOAI_REPORT.md`.
