# Roadmap & status

Legend: ✅ implemented **and** tested · 🟡 implemented, not yet verified against real services · ⬜ not started

## Milestone 1 — Foundation, security model, core voice-to-action (this branch)
| Item | Status | Evidence |
|---|---|---|
| Replace FitPick with My Voice Life app shell (Vite/React/TS/Tailwind v4, router) | ✅ | typecheck + build pass; rendering smoke test at 375px and 1366px, no overflow, no console errors (backend mocked) |
| Remove Gemini key from browser bundle | ✅ | bundle grep: no key/endpoint strings |
| DB schema: profiles, categories, voice_sessions, notes, tasks, reminders, events, subscriptions, usage_counters | ✅ | migration applied twice (idempotent) to local Postgres 16 |
| RLS owner-only on every user table; client cannot self-upgrade plan | ✅ | 34 assertions in `supabase/tests/rls_test.sql` |
| Migration safe on a FitPick-style project (no data loss, no clobbered functions, sign-up still works) | ✅ | 15 checks in `legacy_upgrade_test.sql` on a **simulated** FitPick schema; re-check against the real schema via pre-flight output |
| Migration aborts atomically on an unknown conflicting table | ✅ | guard scenario in `npm run test:db` |
| Read-only pre-flight inspection script | ✅ | runs on simulated schema; write attempts rejected in read-only transaction |
| ~~Free-plan note quota~~ replaced by the AI-capture allowance (manual notes unlimited) | ✅ | see financial controls below |
| New-user bootstrap (profile, 7 default categories, free plan) | ✅ | DB tests |
| Keyword memory search (RLS-safe RPC) | ✅ | DB tests (incl. no cross-user leakage) |
| Extraction validator (no invented dates, bounded output) | ✅ | 11 unit tests |
| Time-zone conversion and recurrence math | ✅ | 8 unit tests (Kigali, Paris DST, Toronto) |
| Proposal → record mapping, priority ranking | ✅ | 8 unit tests |
| `process-voice` Edge Function (auth, reservation, OpenAI transcribe + extract) | 🟡 | `deno check` + 27 Deno tests; **not deployed; not run against real OpenAI/Supabase yet** |
| `delete-account` Edge Function | 🟡 | `deno check` passes; not run against real Supabase |
| Auth: register, login, logout, password reset, persistent session | ✅ live / 🟡 reset | real sign-ups and sign-ins on the live project from the previews (auth logs, 2026-11-19); 8 mocked browser scenarios incl. wrong password, unconfirmed email, existing email, expired link, resend; password reset tested mocked only |
| Pages: Landing, Dashboard, Capture/Review, Notes, Tasks, Schedule, Memory, Settings | 🟡 | render-tested with mocked data; CRUD needs a live project |
| Recorder: duration, cancel, max length, permission-denied handling | 🟡 | denied-permission path tested in Chromium; real recording needs a device mic |
| en/fr interface | ✅ | all keys typed and present in both |
| Vercel config: SPA rewrite, pinned build/output/Node, security headers + CSP | ✅ | `vite preview` serves the same headers; Chromium: 5 routes render, 0 CSP violations |
| Build refuses secret-looking / non-allow-listed `VITE_*` variables | ✅ | 5 unit tests + builds with `VITE_GEMINI_API_KEY` and `sb_secret_` both refused |
| `npm run check:env` (masked env validation + Supabase probes) | 🟡 | written; probes need a live project |
| CORS allow-list with Vercel preview patterns | ✅ | 5 unit tests; `deno check` passes |
| Kinyarwanda test kit (plan, prompts, sheet, transcribe + WER/CER scorer) | ✅ tooling / ⬜ results | 8 metric/CSV tests; dry-run and scoring verified on synthetic data. **No Kinyarwanda results exist yet** |

### Financial controls (approved 2026-11-18; local only, not applied)
| Item | Status | Evidence |
|---|---|---|
| Migration `20261118000002_mvl_financial_controls.sql` (ledger, limits, budgets, kill switch, admin RPCs) | ✅ tested locally + applied (owner-approved) | 82 new DB checks; whole suite 130 checks |
| Free 7 AI captures/month; manual notes unlimited; deleting records never restores allowance | ✅ | DB tests |
| Premium 300 captures **and** 600 audio minutes, enforced independently; configurable without code | ✅ | DB tests |
| Per-hour/per-day rate limits counted from the ledger (not user-deletable rows) | ✅ | DB tests |
| $2/day and $20/month hard budgets with worst-case holds; alerts at 50/80/100%; admin webhook | ✅ DB / 🟡 webhook | DB tests; webhook needs a live deployment |
| Concurrency: simultaneous requests can't bypass limits or budgets | ✅ | two-session race tests; confirmed to fail when the lock is removed |
| Kill switch + `admins_only` test mode (default) | ✅ | DB tests |
| `process-voice` reservation flow, real usage recording, output cap | 🟡 | 27 Deno orchestration tests with fakes + real recordings + CI; **not yet run against real OpenAI/Supabase** |
| OpenAI provider (gpt-transcribe + gpt-6-luna Responses API, strict JSON schema) replacing Gemini | 🟡 | request shapes and response parsing tested against fakes; models and prices verified on developers.openai.com 2026-11-19; **no live call yet (no key, by owner decision)** |
| Server-side audio length from the file (WebM/Ogg/MP4) before reserving | ✅ | parser tests on real Chromium MediaRecorder WebM + ffmpeg Ogg/MP4 fixtures; a 60 s low-bitrate file claimed as 2 s is reserved at 60 s |
| Microphone flow (permission, record, timer, stop/cancel, upload, review, edit/accept/reject, save) | 🟡 | end-to-end in Chromium with a fake microphone and a mocked backend (tester success, denied, in use, non-staff, provider busy); **real phones (iOS Safari, Android Chrome) not tested yet** |
| Multilingual: language registry, interface vs spoken languages (up to 3), mixed-language hints | ✅ code / ⬜ quality | registry + DB tests; **no language verified for voice yet** (needs native-speaker recordings) |
| Google sign-in | 🔴 not working live | cause proven from auth logs: provider disabled in Supabase. Button now hidden while disabled; with provider on, the redirect and the cancel/error paths are browser-tested with mocks. **Needs owner: Google Cloud client + Supabase provider; not fixed until a real Google login succeeds** (docs/GOOGLE_OAUTH_SETUP.md) |
| Privacy policy and terms pages (`/privacy`, `/terms`) | 🟡 draft | factual content checked against the code; linked from landing, register, pricing and settings; **identity, contact, legal basis, refunds, VAT and governing law left for the owner + legal review** |
| Free/Plus/Pro plans, caps, payment grace, upgrade/downgrade, invoices (Stripe test mode) | 🟡 | DB + function + mocked browser tests (simulated Stripe); **migration 6 not applied, functions not deployed, no real test-mode run** (docs/STRIPE_SETUP.md) |
| Bring Your Own AI (user's own OpenAI key in Vault) | 🟡 | DB (Vault access, isolation, deletion, races) + function tests (fakes); **not deployed; no real key tested**; byoai_mode admins_only (docs/BYOAI_SECURITY.md) |
| Note translation | ⬜ | designed (original kept, translation stored beside it, counted as an AI capture); not built |
| Admin dashboard (usage, controls, limits, finance with labels, expenses) | 🟡 | render-tested with mocked data under the real CSP; needs a live DB |
| Allowance display + refusal messages in the app | 🟡 | render-tested with mocked data |
| Actual AI cost of premium allowance measured from real usage | ⬜ | required before commercial launch |

### Blocked on owner action (see docs/DEPLOYMENT.md)
1. ~~Decide where the code lives~~: done, moved to the dedicated repo `hen12r/my-voice-life` with full history.
2. Create the `my-voice-life` Vercel project from `hen12r/my-voice-life` (Root Directory `.`), never reusing Photosentry's env vars.
3. Create a fresh Supabase project (recommended) or restore the paused one; run the read-only pre-flight; approve the migration.
4. Set `OPENAI_API_KEY` + `ALLOWED_ORIGINS` as Supabase Function Secrets (responsible adult, docs/OPENAI_SETUP.md); remove any old `GEMINI_API_KEY`, and **rotate the old Gemini key** if FitPick was ever deployed.
5. Record Kinyarwanda clips with written consent (docs/kinyarwanda/TEST_PLAN.md).

## Milestone 2 — Verify end-to-end on the real project
⬜ Apply migration, deploy functions, run the manual test plan below, fix what breaks · ⬜ Kinyarwanda WER evaluation and provider decision · ⬜ Translate validator warnings

## Milestone 3 — Reminders that actually fire
⬜ `pg_cron` job → Edge Function → Web Push (VAPID) with notification permission flow · ⬜ Service worker (installable PWA, offline shell) · ⬜ Server-side recurrence advance after delivery

## Milestone 4 — Memory intelligence
⬜ pgvector embeddings on notes and transcripts · ⬜ "Ask your memory": answer **only** from retrieved records, each claim linked to its source, AI suggestions visually separated · ⬜ Transcript translation (keep original)

## Milestone 5 — Daily briefing & weekly report
⬜ Daily briefing (opt-in, `daily_briefing_enabled` already in schema) · ⬜ Weekly report from real completed/unfinished/upcoming data

## Milestone 6 — Business
⬜ Decide payment provider (Stripe availability for your country vs mobile money) · ⬜ Checkout + webhook writing `subscriptions` with the service role · ⬜ Billing page · ⬜ Revisit free-tier metric (see docs/PRODUCT.md)

## Milestone 7 — Production readiness
⬜ Vercel deployment config + env · ⬜ Custom SMTP · ⬜ Error monitoring · ⬜ Code splitting · ⬜ Playwright e2e against a Supabase branch · 🟡 Privacy policy (draft) · ⬜ Data export

## Manual test plan (once the project is live)
1. Register → confirm email → land on dashboard; check that Settings shows your device time zone and 7 categories.
2. Speak: "Tomorrow I need to call my school, prepare my CV, buy a notebook and practise piano." Expect 4 tasks dated tomorrow, each editable. Save and check them in Tasks and the dashboard.
3. Speak: "Remind me to call mum this weekend." Expect a reminder flagged "choose a date" and Save disabled until you pick one.
4. Deny microphone permission → a clear message is shown and typing still works.
5. As a free test user (staff/tester while in `admins_only` mode), make 7 AI captures → the 8th is refused with the monthly-limit message and "Write a note instead". Delete notes or sessions → still refused. Manual notes still save.
5b. Admin → AI controls → Off → capture refused with the paused message; switch back on.
5c. Admin → set the daily budget just above today's spend → new captures stop with the budget message; an alert appears and the webhook (if set) fires.
6. Second account in a private window: none of the first account's data is visible, including in Memory search.
7. Settings → delete account → you're signed out, and logging in again fails.

## Interface and motion (2026-11-19)
| Item | Status | Evidence |
|---|---|---|
| Signature microphone orb reacting to the real input level (AnalyserNode RMS) | ✅ desktop Chromium / 🟡 phones | fake-microphone file with silence/loud/quiet/silence → measured levels 0 / 0.29 / 0.05 / 0; real phones not tested |
| Live waveform from real level history, shown only while recording | ✅ | same test; hidden in every other state |
| Honest processing stages (upload % from real XHR progress, then "Understanding…") | ✅ | browser test with mocked backend; percentage hidden when the browser reports none |
| Review cards: staggered entrance, edit, reject + undo | ✅ | browser test (accept/edit/reject/undo, save) |
| Optional sound cues (off by default) | ✅ | unit tests; toggle in Settings |
| Reduced motion | ✅ | emulated `prefers-reduced-motion: reduce`: no breathing, rings or stagger |
| Task completion feedback | ✅ | browser test |
| Installable app (PWA): service worker, offline page, safe updates, install card, shortcuts, screenshots | ✅ Chromium / 🟡 devices | `npm run test:pwa` (real Chromium, production build, mocked Supabase): installability 0 errors; **real iPhone/Android/Safari not tested** |
| Reminder notifications (Web Push) | ⬜ | not built: needs VAPID keys, subscriptions table, scheduler (docs/PLATFORMS.md) |
| Store apps (Play via TWA, App Store via Capacitor) | ⬜ prepared | TWA template + steps; nothing built or published |

## Payments: Stripe, test mode (2026-11-20, branch `claude/stripe-billing`)
| Item | Status | Evidence |
|---|---|---|
| Migration 5: Stripe statuses, webhook ledger, service-role link/apply functions | ✅ tested locally / ⬜ not applied | `billing_test.sql` (40+ checks); rollback refusal, round trip and re-apply tested |
| Webhook: signature, replay window, test/live separation, re-fetch, price allow-list, idempotency | ✅ offline / ⬜ live Stripe | 20 Deno tests + Vitest signature tests against Node crypto; mutation-checked |
| Checkout and Customer Portal (server-side price, customer bound to user, origin allow-list) | ✅ offline / ⬜ live Stripe | 14 Deno tests; mutation-checked |
| Account deletion cancels the Stripe subscription first | ✅ offline | 6 Deno tests |
| Pricing page, success page (server-confirmed only), Settings plan card, en/fr | ✅ mocked browser | 11 browser scenarios at 360 px and desktop, 0 console errors |
| Real test-mode run with a Stripe account | ⬜ | needs the owner's Stripe test account, secrets and approvals (`docs/STRIPE_SETUP.md`) |
| Taxes/VAT, terms, refund policy, recorded revenue in admin | ⬜ | required before live payments |

