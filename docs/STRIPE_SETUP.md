# Stripe payments: setup and testing (TEST MODE ONLY)

> **Live status, checked 21 Nov 2026 against the real deployment:**
> - `billing` and `stripe-webhook` are deployed but **not configured** (no Stripe secrets).
> - The Pricing page loads the real `billing` function and shows "Premium is not available yet. No payment can be taken."
> - A webhook call with a bad signature returns `503 billing_not_configured`.
> - 0 Stripe events and 0 premium subscriptions in the database.
> - Nothing below has been run against Stripe yet. The test-mode checklist ("Test in test mode") is still to do once the responsible adult has created the test account and secrets.

**Status (2026-11-20):** built and tested offline, but **not connected.**
- No Stripe account is linked, no key is stored anywhere, and nothing is deployed.
- Migration 5 is **not applied**.
- Real payments are **impossible by design** until you explicitly allow them (see "Safety").

A **responsible adult must own the Stripe account**: Stripe requires the account holder to be someone who can legally accept its terms. Check that Stripe supports your country before you start (stripe.com/global).

---

## How it works
```
Browser ──"subscribe monthly"──▶ billing function ──▶ Stripe: create Customer (once) + Checkout Session
   │                                  │ (price chosen by the SERVER, customer linked to YOUR user id)
   ◀──────── Stripe-hosted URL ───────┘
   └──▶ checkout.stripe.com  (card entered on Stripe's page; the app never sees card data)
                │
Stripe ──signed webhook──▶ stripe-webhook function
                             1. verifies the Stripe-Signature (raw body, secret, 5-min window)
                             2. rejects live events while in test mode
                             3. RE-FETCHES the subscription from Stripe's API (payload not trusted)
                             4. mvl_billing_apply_subscription() → subscriptions row (idempotent)
Browser ◀── /app/billing/success polls the SERVER's plan; the URL itself proves nothing
```
- **Premium comes from one place only:** `effective_plan()` in the database. A user is Premium while their status is `active` or `trialing` **and** the period hasn't ended. That is the existing rule; it isn't changed.
- **What each status means for access:**
  - **Failed payment** (`past_due`) or **retries exhausted** (`unpaid`): Premium pauses until the payment succeeds.
  - **Cancelled at period end:** Premium continues until the end date.
  - **Deleted** (`canceled`) or **first payment never completed** (`incomplete_expired`): back to Free.
  - **No renewal confirmed by the end date:** Premium stops by itself, even if a webhook is missed.
- **Manage subscription** opens the **Stripe Customer Portal**: change card, cancel, invoices.
- **Deleting an account** cancels the Stripe subscription first. If that fails, the account isn't deleted, so a deleted user never keeps paying.

## Safety
- **Keys are server-side only.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` live in **Supabase Edge Function secrets**. They are never in the browser, Vercel, GitHub, or logs. The build guard refuses any `VITE_STRIPE_*`-style secret.
- **Test-mode lock:**
  - Live keys (`sk_live_`, `rk_live_`) are **refused** unless a secret `STRIPE_LIVE_MODE_APPROVED=true` also exists. Don't create it.
  - Live webhook events are rejected while the key is a test key, and test events are rejected in live mode.
- **The browser never chooses anything that matters.** It can't pick a price, an amount, a customer, or a redirect URL. Only Stripe-hosted URLs (`checkout.stripe.com`, `billing.stripe.com`) are followed.
- **Every webhook is checked:**
  - unsigned, forged, tampered or older-than-5-minutes webhooks get `400`;
  - each event is applied at most once;
  - a customer is bound to exactly one user;
  - metadata naming another user is refused.
- **Unknown prices never grant access.** A subscription on a price the app doesn't know never grants Premium. Cancellations are always applied.

---

## Owner steps (test mode). Never paste any key into a chat.
**1. Stripe account, in Test mode** (an adult owns it)
- Use the Dashboard's test mode / sandbox. Everything below happens there.

**2. Product and prices** (you choose the amounts; the app doesn't invent prices)
- Create a product "My Voice Life Premium" with a **recurring monthly** price.
- Optionally add a **recurring yearly** price.
- Copy each **Price ID** (`price_…`). These are not secret, but they live in Supabase secrets so they're server-controlled.
- The Pricing page shows exactly the amount and currency Stripe returns for these IDs. Zero-decimal currencies such as RWF and UGX are displayed correctly.

**3. Customer Portal**
- Dashboard → Settings → Billing → Customer portal.
- Allow: update payment method, cancel subscription (at period end recommended), invoice history.
- Save it once in test mode, or portal sessions will fail.

**4. API key**
- Recommended: a **restricted key** (`rk_test_…`) with only:
  - Customers: write;
  - Checkout Sessions: write;
  - Customer portal: write;
  - Subscriptions: write (needed to cancel on account deletion);
  - Prices: read.
- A standard `sk_test_…` key also works.

**5. Webhook endpoint**
- URL: `https://nwglzabnezhmxfyuxhmg.supabase.co/functions/v1/stripe-webhook`
- Events to send:
  - `checkout.session.completed`
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
  - `customer.subscription.paused`, `customer.subscription.resumed`
  - `invoice.paid`, `invoice.payment_failed`
- Copy its **signing secret** (`whsec_…`).

**6. Supabase → Edge Functions → Secrets** (typed by you, in the dashboard)

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `rk_test_…` or `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `STRIPE_PRICE_PREMIUM_MONTHLY` | `price_…` |
| `STRIPE_PRICE_PREMIUM_YEARLY` | `price_…` (optional) |
| `ALLOWED_ORIGINS` | must include the preview origin you test from (already used by the other functions) |

**7. Approvals I need from you.** Each one is separate. I'll show the result after each.
1. "Approve migration 5": the exact SQL is in [`MIGRATION_5_BILLING_REVIEW.md`](MIGRATION_5_BILLING_REVIEW.md).
2. "Approve deploying billing, stripe-webhook and delete-account".
   - These are the **test-mode** functions.
   - They go to the only Supabase project (`nwglzabnezhmxfyuxhmg`), which is also what the previews use.
   - The functions stay inert without the secrets from step 6.

---

## Test the whole flow (after steps 1–7)
Use the preview link, signed in.

| # | Do | Expect |
|---|---|---|
| 1 | Open **/pricing** | "Test mode" banner, your price from Stripe, limits 7 / 300 |
| 2 | **Subscribe** → card `4242 4242 4242 4242`, any future date, any CVC | Stripe Checkout, then "Confirming…" → "Premium is active" within seconds |
| 3 | Settings → Plan | Premium, "Renews on …", **Manage subscription** |
| 4 | Stripe Dashboard → Developers → Webhooks → your endpoint | `200` deliveries; Supabase function logs show `→ applied` |
| 5 | Resend the same event from the Dashboard | `200 duplicate`: nothing changes |
| 6 | **Manage subscription** → cancel | Back in the app: "Ends on …"; still Premium until then |
| 7 | Checkout with a declined card such as `4000 0000 0000 9995` | Stripe shows the decline on its page; the app stays Free |
| 8 | Renewal and failed renewal | Use **Stripe test clocks** to advance time. Use `4000 0000 0000 0341` (attaches fine, then fails when charged) for a failed renewal → "Your last payment failed", Free limits |
| 9 | Delete a test account that has a subscription | The subscription is cancelled in Stripe first |

Test-clock note: a test clock applies to customers created on that clock, and the app creates its own customers. For step 8, follow Stripe's test-clock guide (Billing → test clocks), or rely on the automated renewal and failed-payment tests below. I haven't run the Dashboard steps myself: no account is connected.

## What the automated tests prove (no Stripe account needed)
- **`npm run test:db`** (`billing_test.sql`, 40+ checks) covers the database side:
  - successful payment, renewal, failed payment and recovery, unpaid, cancellation at period end, deletion;
  - expiry with no webhook, `incomplete_expired`;
  - duplicate events, late events about an old subscription;
  - a customer bound to one user, metadata spoofing, unknown customers;
  - permissions: users and visitors can't call the functions or write their row;
  - the rollback refuses once billing data exists.
- **`npm run test:functions`** covers the Edge Functions:
  - **webhook:** signature missing, forged, tampered or replayed; live event in test mode; re-fetch beats the payload; the price allow-list; retries on outages;
  - **billing:** server-side price, idempotent customer creation, origin allow-list, no second checkout for existing subscribers, portal;
  - **delete-account:** subscription cancelled first.

  Mutation-checked: disabling the signature check fails 4 tests, and trusting a browser-sent price fails 1.
- **`npm test`** (Vitest) covers:
  - signature verification, checked against Node's crypto as an independent reference;
  - the test-mode key guard;
  - event and snapshot parsing (both API shapes);
  - currency formatting;
  - every billing error has en/fr text.
- **Browser checks** (mocked backend, 360 px and desktop):
  - the Pricing page, signed out and signed in;
  - Checkout redirect, a non-Stripe URL refused, the cancel notice;
  - the success page waits for the server, and a forged success URL never shows Premium;
  - Settings for a premium user who cancelled, and for a failed payment;
  - French.

  No horizontal scrolling, and no console errors.

## Known limitations and decisions for you
- **A failed payment pauses Premium immediately** (`past_due`), which is the existing `effective_plan` rule. If you prefer a grace period during Stripe's retries, that's a small, separate change.
- **Two checkouts in two tabs at the same moment** could create two subscriptions. A second checkout is refused once the first is recorded, and the portal can cancel the extra one.
- **Not done yet:**
  - **Taxes/VAT:** Stripe Tax is not enabled.
  - **Terms and refund policy:** not written.
  - **Admin revenue figures:** they still show *projected* revenue (not read from Stripe invoices).

  All three are needed before live payments.
- **Pinned Stripe API version** `2026-11-18.endive` (override: secret `STRIPE_API_VERSION`). Both the old and new subscription shapes are read. A real test-mode run is the final check.

## Going live (later, only with your explicit approval)
1. Taxes, terms, refund policy and privacy policy in place.
2. Live product and prices; live webhook endpoint; live restricted key.
3. Add the secret `STRIPE_LIVE_MODE_APPROVED=true`. Until it exists, live keys are refused.
