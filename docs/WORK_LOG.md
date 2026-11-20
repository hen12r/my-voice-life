# Work log

A record of completed and unfinished work. Newest first. "Verified" means a test or tool output shows it; anything else is labelled.

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

## Earlier milestones
See `docs/ROADMAP.md` (status table with evidence) and the PR #1 description.
