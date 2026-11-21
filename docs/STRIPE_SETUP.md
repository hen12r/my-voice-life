# Stripe payments: setup and testing (TEST MODE ONLY)

**Business model (owner decision, 21 Nov 2026):** Freemium + Bring Your Own AI.
- Plans: **Free $0**, **Plus $4.99/month**, **Pro $9.99/month**. These are proposed prices, not final; the real amounts are whatever you create in Stripe.
- Plans pay for the app and its limits. **No plan includes AI credits.** Voice uses the user's own OpenAI key, and OpenAI bills them directly.

**Status (21 Nov 2026):** built and tested offline (simulated Stripe), **not connected and not deployed.**
- No Stripe account is linked and no Stripe key is stored anywhere.
- Migration 6 (plans free/plus/pro) is **not applied**.
- The live `billing` and `stripe-webhook` functions are still the earlier single-Premium version, and unconfigured.
- Real payments are **impossible by design** until you explicitly allow them (see "Safety").

A **responsible adult must own the Stripe account**: Stripe requires an account holder who can legally accept its terms. Check that Stripe supports your country first (stripe.com/global).

---

## How it works
```
Browser ──"subscribe to Plus"──▶ billing function ──▶ Stripe: Customer (once) + Checkout Session
   │                                 │ (the browser names a plan; the SERVER picks the price)
   ◀──────── Stripe-hosted URL ──────┘
   └──▶ checkout.stripe.com  (card entered on Stripe's page; the app never sees card data)
                │
Stripe ──signed webhook──▶ stripe-webhook function
                             1. verifies the Stripe-Signature (raw body, secret, 5-minute window)
                             2. rejects live events while in test mode
                             3. RE-FETCHES the subscription from Stripe (payload not trusted)
                             4. plan = the price's plan in the server allow-list (Plus or Pro)
                             5. mvl_billing_apply_subscription_v2() → subscriptions row (idempotent)
Browser ◀── /app/billing/success polls the SERVER's plan; the URL itself proves nothing
```
- **The plan comes from one place only:** `effective_plan()` in the database.
  - A paid plan counts while the status is `active`/`trialing` **and** the period hasn't ended.
  - **Failed payment (`past_due`):** the plan is kept during a **grace period** (default 7 days after the period end, configurable as `billing_grace_days`) while Stripe retries.
  - **`unpaid`, `canceled`, `incomplete_expired`, or no renewal confirmed:** back to Free.
- **Upgrade / downgrade** (Plus ↔ Pro): the Billing page opens Stripe's own confirmation page (Customer Portal `subscription_update_confirm`). It acts on the user's own subscription item with the server-chosen price. Stripe handles proration, and the webhook updates the plan.
- **Cancel, card change, invoices:** the Stripe Customer Portal. Invoice history is also shown in the app (Stripe-hosted links only).
- **Deleting an account** cancels the Stripe subscription first. If that fails, the account isn't deleted.
- **Plan limits** (reminders, events, BYOAI captures, recording length) live in the `mvl_plan_limits` table, not in code. Database triggers enforce them.

## Safety
- **Keys are server-side only.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` live in Supabase Edge Function secrets. They are never in the browser, Vercel, GitHub or logs.
- **Test-mode lock:** live keys are **refused** unless the secret `STRIPE_LIVE_MODE_APPROVED=true` also exists. Don't create it. Live events are rejected in test mode and vice versa.
- **The browser never chooses anything that matters:** no price, amount, customer, plan-for-a-price, or redirect URL. Only `checkout.stripe.com` / `billing.stripe.com` URLs are followed.
- **Every webhook is checked:** signature, freshness, mode, re-fetch.
  - Each event is applied **at most once**: the `mvl_stripe_events` ledger is also the audit trail (event, outcome, user, time).
  - A customer is bound to exactly one user; metadata naming another user is refused.
  - An **unknown price grants nothing**; cancellations always apply.
- **Duplicate payments:**
  - checkout is refused while a live subscription exists (use "change plan" instead);
  - a double click opens one Checkout Session (idempotency key per user/plan/minute);
  - customers are created once (idempotency key per user).

---

## Owner steps (test mode). Never paste any key into a chat.
**1. Stripe account, in Test mode** (an adult owns it). Everything below happens in test mode / a sandbox.

**2. Products and prices** (you choose the amounts; the app shows exactly what Stripe returns)
- Product **"My Voice Life Plus"** → a **recurring monthly** price (proposed 4.99).
- Product **"My Voice Life Pro"** → a **recurring monthly** price (proposed 9.99).
- Copy each **Price ID** (`price_…`). Two different prices are required; the same price for both plans is refused.

**3. Customer Portal** (Dashboard → Settings → Billing → Customer portal)
- Allow: update payment method, **cancel subscription** (at period end recommended), invoice history.
- **Subscription update: on**, with both products and their monthly prices listed. Choose your proration behaviour (Stripe's default is fine). Without this, "change plan" fails.
- Save it once in test mode.

**4. API key.** Recommended: a **restricted key** (`rk_test_…`) with only:
- Customers: write;
- Checkout Sessions: write;
- Customer portal: write;
- Subscriptions: write (needed to cancel on account deletion);
- Prices: read;
- Invoices: read (billing history).

**5. Webhook endpoint:** `https://nwglzabnezhmxfyuxhmg.supabase.co/functions/v1/stripe-webhook`
- Events:
  - `checkout.session.completed`;
  - `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`;
  - `invoice.paid`, `invoice.payment_failed`.
- Copy its **signing secret** (`whsec_…`).

**6. Supabase → Edge Functions → Secrets** (typed by you, in the dashboard)

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `rk_test_…` or `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `STRIPE_PRICE_PLUS_MONTHLY` | Plus `price_…` |
| `STRIPE_PRICE_PRO_MONTHLY` | Pro `price_…` |

The old `STRIPE_PRICE_PREMIUM_*` names are no longer read.

**7. Approvals I need from you** (each separate; I show the result after each)
1. "Approve migration 6": the exact SQL is in `supabase/migrations/20261122000001_mvl_plans_byoai.sql`.
   - Pre-flight (read-only): `supabase/preflight/preflight_20261122_migration_6.sql`. Run on 21 Nov: **0 user rows would change**.
   - Rollback: `supabase/rollback/rollback_20261122_migration_6_plans_byoai.sql` (tested).
2. "Approve deploying billing, stripe-webhook, process-voice, ai-connections". All four go to the only Supabase project, which the previews also use. Stripe stays inert without step 6.

---

## Test the whole flow in Stripe TEST mode (after steps 1–7)
Use the preview, signed in. Mark each line ✅/❌.

| # | Do | Expect |
|---|---|---|
| 1 | Open **/pricing** | "Test mode" banner; Plus and Pro prices exactly as in Stripe; the "AI usage is billed separately" notice |
| 2 | **Subscribe to Plus** → card `4242 4242 4242 4242`, any future date, any CVC | Stripe Checkout → "Confirming…" → active within seconds; Billing shows Plus, "Renews on …" |
| 3 | Stripe Dashboard → Webhooks → your endpoint | `200` deliveries; Supabase logs `→ applied` |
| 4 | Resend the same event from the Dashboard | `200 duplicate`; nothing changes |
| 5 | Billing → **Upgrade to Pro** → confirm on Stripe | Back on Billing: "sent to Stripe" notice, then Pro once the webhook arrives; a proration invoice in the history |
| 6 | Billing → **Switch to Plus** | Plus again after Stripe confirms |
| 7 | Billing → **Manage or cancel** → cancel | "Ends on …"; the plan stays until then |
| 8 | Checkout with `4000 0000 0000 9995` (declined) | Stripe shows the decline; the app stays Free |
| 9 | Renewal and failed renewal: Stripe **test clocks** + card `4000 0000 0000 0341` | Renewal extends the date. A failed renewal shows "Your last payment failed", keeps the plan during the grace period, then Free after `unpaid` |
| 10 | Delete a test account that has a subscription | Subscription cancelled in Stripe first |

Test-clock note: a test clock applies to customers created on that clock, and the app creates its own customers. Follow Stripe's test-clock guide for step 9, or rely on the automated renewal and failed-payment tests below. **No test-mode run has been done yet:** no account is connected.

## What the automated tests prove (SIMULATED: no Stripe account needed)
- **`npm run test:db`**:
  - plans and caps; webhook apply v2 (upgrade, downgrade, grace window, unpaid, cancellation, expiry, duplicate and late events, cross-user safety);
  - permissions; BYOAI Vault access; race tests;
  - migration 6 rollback with refusals.
- **`npm run test:functions`** (100 tests):
  - webhook: signature, mode, re-fetch, plan from the price allow-list, forged plan ignored, retries;
  - billing: checkout per plan, idempotency, change_plan on the user's own item, invoices (own customer, Stripe links only), origin checks;
  - ai-connections; process-voice routing; delete-account.
- **`npm test`**: price→plan mapping, plan features, voice access, error messages (en/fr).
- **Mocked browser** (360/390/768/1366 px):
  - Pricing signed out, unconfigured, free → subscribe, Plus → upgrade;
  - Billing with a failed payment and a pending change;
  - the AI key card.

## Known limitations and decisions for you
- **Taxes/VAT:** Stripe Tax is not enabled. Needed before live payments in the EU.
- **Terms and refund policy:** drafts with placeholders (see `/terms`).
- **Admin revenue figures** are *projected* from list prices, not read from Stripe.
- **Pinned API version** `2026-11-18.endive` (override: `STRIPE_API_VERSION`).

## Going live (later, only with your explicit approval)
1. Taxes, terms, refund policy and privacy policy completed and reviewed.
2. Live products and prices; live webhook endpoint; live restricted key.
3. Add the secret `STRIPE_LIVE_MODE_APPROVED=true`. Until it exists, live keys are refused.
