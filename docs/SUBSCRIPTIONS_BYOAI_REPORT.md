# Subscriptions + Bring Your Own AI: report

**Branch:** `claude/stripe-billing` (draft PR #4). **Date:** 21 November 2026.
**Nothing was deployed, migrated, merged or charged.** Stripe stays in test mode and isn't connected.

## Owner decisions, and my objections (on record)
| Decision | My objection |
|---|---|
| **Pure BYOAI:** no plan includes AI | Most target users (students) have no funded OpenAI API account, so they get **no voice**, the core feature. Expect low activation. |
| **Pro = bigger limits only** | Honest, but thin: it adds 3× captures per day and 10-minute recordings. "Advanced workflows / multiple providers / priority support" are **not** offered, because they don't exist (rule 7). |
| **Free keeps reminders and events, with caps** | Agreed. 10 active reminders and 20 upcoming events, configurable. |
| **Build key storage now (OpenAI only)** | Done, with a written threat model (`docs/BYOAI_SECURITY.md`). |

## 1. What already existed
- Plans `free`/`premium`, enforced by `effective_plan()`. Premium's only benefit was a bigger *included* AI allowance.
- Stripe test-mode code for **one** plan: Checkout, Customer Portal, a signature-verified and idempotent webhook (re-fetching from Stripe), account deletion cancelling first. Deployed but unconfigured.
- RLS on every table; financial tables writable only through SECURITY DEFINER RPCs.
- Supabase Vault installed but unused.

## 2. What I changed (commits `5b807ae` → `467cca8`)
- **Migration 6** (`supabase/migrations/20261122000001_mvl_plans_byoai.sql`), local only:
  - plans become `free/plus/pro`;
  - configurable caps in `mvl_plan_limits`, enforced by triggers with per-user locks;
  - a 7-day payment grace period for `past_due` (configurable);
  - `mvl_billing_apply_subscription_v2` (plan derived server-side);
  - BYOAI key storage in Vault (service-role-only RPCs; users see a hint);
  - a separate BYOAI usage table with plan rate limits;
  - the `byoai_mode` switch (default `admins_only`);
  - admin RPCs; finance estimates for plus/pro.
  - Also: a tested **rollback** and a read-only **pre-flight**. Migration 2's seed inserts were guarded so the migration set stays re-runnable (no effect on databases that already applied it).
- **Stripe functions:**
  - prices per plan (`STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`);
  - webhook maps price → plan from the allow-list only;
  - `billing` checkout per plan (double-click safe);
  - `change_plan` (upgrade/downgrade through Stripe's confirmation page on the user's own item);
  - portal returns to Billing;
  - `invoices` (own customer, Stripe-hosted links only).
- **BYOAI:**
  - new `ai-connections` function: validates the key with OpenAI before storing it, never returns it, throttles attempts;
  - `process-voice` uses the user's own key with BYOAI limits;
  - staff testing keeps the platform key path; everyone else gets `ai_key_required`;
  - rejected key → marked invalid; no credit / no model access → specific messages.
- **Frontend:**
  - Pricing: 3 plans, a feature list generated from the database limits, and a prominent "AI usage is billed separately" notice;
  - new **Billing** page: plan, status, renewal, change plan, manage/cancel, usage against caps, invoices;
  - Settings → **Your AI provider** card;
  - Capture shows the right state;
  - plan-limit errors translated (en/fr).
- **Docs:**
  - `STRIPE_SETUP.md` rewritten;
  - new `BYOAI_SECURITY.md`;
  - privacy and terms drafts updated for BYOAI and the plans.

## 3. What remains incomplete
| Item | Priority |
|---|---|
| **No real Stripe test-mode run:** no account exists. Every payment result below is simulated. | HIGH |
| **No real BYOAI run:** no real OpenAI key has been validated or used. | HIGH |
| Migration 6 and 4 function deploys: not done; need your approval. | HIGH |
| Taxes/VAT (Stripe Tax), refund policy, legal identity in Terms/Privacy | CRITICAL for live payments |
| French texts for the new UI: written by me, **need a fluent speaker's review** (CLAUDE.md) | MEDIUM |
| Admin UI for the new caps and `byoai_mode` (RPCs exist; no screen yet) | LOW |
| `ai-connections` throttle is per function instance (in memory), not global | LOW |
| Real phones not tested | MEDIUM |

## 4. Database migrations required
- **Migration 6** only: `20261122000001_mvl_plans_byoai.sql`. Additive and re-runnable.
- **Pre-flight on the live project (read-only, 21 Nov):**
  - 0 `premium` rows, 0 Stripe subscriptions, so **0 user rows would change**;
  - Vault available and empty;
  - nobody above the new caps.
- **Rollback:** `supabase/rollback/rollback_20261122_migration_6_plans_byoai.sql`. It refuses, changing nothing, once keys, BYOAI usage or paid Stripe subscriptions exist.
- **Deploy order after approval:** migration 6, then `stripe-webhook`, `billing`, `process-voice`, `ai-connections`. The deployed `stripe-webhook` v1 calls the old apply function that migration 6 removes. It is unconfigured (it answers 503 before touching the database), so there is no live impact. It must still be redeployed right after the migration.

## 5. Stripe configuration required
Two products with monthly prices (Plus, Pro); the Customer Portal with **subscription update on**; a restricted key (Customers, Checkout, Portal, Subscriptions write; Prices, Invoices read); the webhook endpoint with 8 events; 4 Supabase secrets. Details: `docs/STRIPE_SETUP.md` → "Owner steps".

## 6. Test results
| Kind | Result |
|---|---|
| **Automated, DB** (`npm run test:db`, local throwaway Postgres) | All suites pass: core RLS, financial, multilingual, billing (v2: upgrade, downgrade, grace, unpaid, cancel, expiry, duplicates, late events, cross-user), **plans + BYOAI** (caps, Vault access only by service role, user isolation, deletion removes secrets, rate limits), 3 rollback scenarios, 4 race tests, legacy upgrade, guard |
| **Automated, Edge Functions** (`npm run test:functions`, fakes) | **100 passed**: webhook 22, billing 23, process-voice 39 (9 BYOAI), ai-connections 10, delete-account 6 |
| **Automated, unit** (`npm test`) | **167 passed** |
| **Type-check / build / `deno check`** | Pass |
| **Mocked browser** (Chromium, fake backend, 360/390/768/1366 px) | 8 scenarios pass: Pricing signed out / unconfigured / free → subscribe (body `{plan:"plus"}` only) / Plus → upgrade (`change_plan`, no second checkout); Billing past-due + pending change (no fake success) + invoices; the AI key card (masked, cleared, never on the page, sent only to `ai-connections`); Capture both states. No overflow, no console errors. |
| **Stripe TEST MODE (real)** | **Not run.** No account. |
| **Real OpenAI with a user key** | **Not run.** |

Requested scenarios, as tested:
- **Proven by DB and function tests (simulated):** new subscription, successful payment, failed payment, cancellation, renewal, upgrade, downgrade, expiry, webhook retries/duplicates, unauthorised access, user data isolation.
- **Not yet done:** none of these has run against real Stripe.

## 7. Steps for the adult account owner
1. Create a Stripe account (test mode) that you own.
2. Follow `docs/STRIPE_SETUP.md` steps 2–6: products and prices, portal with subscription updates, restricted key, webhook, 4 secrets. Type keys only into the Stripe and Supabase dashboards, never into chat.
3. Reply "approve migration 6", then "approve deploying billing, stripe-webhook, process-voice, ai-connections".
4. Run the 10-step test-mode checklist in `STRIPE_SETUP.md` and send me ✅/❌ per line. I'll verify the database rows (read-only).
5. For BYOAI: connect your own OpenAI key in Settings (set a spending limit on OpenAI first), then run the voice checklist in `docs/PROCESS_VOICE_DEPLOY_CHECKLIST.md`.
6. Before any live payment: Stripe Tax/VAT, a refund policy, the legal identity in Terms and Privacy, then `STRIPE_LIVE_MODE_APPROVED=true` (only you set it).

## Proposed CLAUDE.md rule changes (for your approval; not applied)
- **Rule 3 (add):** "User-provided AI keys (BYOAI) are stored only in Supabase Vault through service-role RPCs, are never returned to the browser or logged, and BYOAI calls must obtain `mvl_reserve_byoai_capture()` (kill switch, `byoai_mode`, plan rate limits) before any provider call. Platform AI budgets apply only to the platform key."
- **Rule 13 (add):** "`byoai_mode` stays `admins_only` until the owner approves it after a privacy review and a real end-to-end test."
- **Rule 14 (amend):** "Plans are free/plus/pro; the plan is derived only from the server price allow-list in `stripe-webhook`."
