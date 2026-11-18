# Cost control plan

Status: **audit approved; controls implemented locally (2026-11-18), not yet applied to any live database.** No paid plan, billing account or paid API has been enabled. Section 5 shows the implementation status.
Prices were checked on the providers' own pricing pages on **2026-11-18**. They change, so re-check before relying on them. USD prices are shown as published; where a € figure appears it assumes **$1 ≈ €0.90**, so replace it with the real rate.

## 1. Services, plans and charges
| Service | Used for | Current plan | Monthly cost now | Possible extra charges | Essential now? | Can stay free? |
|---|---|---|---|---|---|---|
| **GitHub** (`hen12r/my-voice-life`, private) | code, PRs | Free | $0 | Actions minutes only if CI is added (private repos have a free monthly quota) | Yes | **Yes** |
| **Vercel** (`my-voice-life` project, not created yet) | hosting the web app | Hobby (free) | $0 | Hobby has hard limits (100 GB transfer, 1M requests…) and **pauses** when exceeded rather than charging. Pro is **$20/user/month** with $20 usage credit and spend management | Yes | **During development, yes.** Vercel's Hobby plan is intended for personal, non-commercial use, so check Vercel's fair-use terms. I couldn't load that page today. Assume **Pro is needed at commercial launch** |
| **Supabase** (My Voice Life project, not created yet) | database, auth, Edge Functions | Free | $0 | Free plan: 500 MB DB, 50k MAU, 500k function calls, 5 GB egress, **paused after 1 week of inactivity**, no backups, max 2 active projects (Photosentry already uses one). Pro is **$25/month** with a spend cap on by default | Yes | **During development, yes.** At launch, Pro is effectively required (no pausing, daily backups) |
| **Google Gemini API** | transcription + extraction (`process-voice`) | not set up | $0 | **The only usage-based cost that grows per user** (section 2). Free tier: $0, but Google **may use the content to improve its products**. Paid tier: billed per token, not used for training | Yes, for the core feature | **Only with synthetic/test data.** Real users' voice notes must not go to the free tier (rule 12). The paid tier needs your approval to enable billing |
| **Google Cloud Speech-to-Text** (`rw-RW`) | only if Gemini fails the Kinyarwanda test | not used | $0 | per audio minute | No | n/a (not added) |
| **Stripe** | future subscriptions | not created | $0 | per transaction (section 4). No monthly fee | No | n/a, and not active (as instructed). **Check that Stripe supports your business's country first** |
| **Email (auth emails)** | sign-up and password reset | Supabase built-in sender | $0 | Built-in sender is heavily rate-limited; real launch needs an SMTP provider (several have free tiers) | Not for testing | Yes, at low volume |
| **Domain** | custom URL | none | $0 | roughly €10–15/year | No | Use `*.vercel.app` until launch |
| npm packages (React, Supabase JS, Tailwind, lucide, Vite, Vitest) | code libraries | open source | $0 | none | — | Yes |
| Firecrawl / other tools used during development | research only | not part of the app | — | — | No | not part of the running app |

**No paid dependency is used by the app today.** Every library is open source; every service is on a free plan or not created yet.

## 2. AI cost per capture (estimate, from published prices)
Gemini counts audio at **32 tokens per second** (1,920 tokens per minute). Each capture makes two calls: transcription (audio in, transcript out) and extraction (prompt + transcript in, JSON out).

| Model (paid tier, $ per 1M tokens) | Audio in | Text in | Output (incl. thinking) |
|---|---|---|---|
| Gemini 2.5 Flash (current default) | 1.00 | 0.30 | 2.50 |
| Gemini 2.5 Flash-Lite | 0.30 | 0.10 | 0.40 |

| Capture | Tokens (approx.) | 2.5 Flash | 2.5 Flash-Lite |
|---|---|---|---|
| 30 s, thinking off | 960 audio + ~750 text in, ~450 out | **≈ $0.0023** | **≈ $0.0005** |
| 5 min (max length), thinking off | 9,600 audio + ~1,800 text in, ~1,800 out | **≈ $0.015** | **≈ $0.004** |
| 30 s, thinking **on** (current code) | adds an unknown 500–2,000 thinking tokens per call | ≈ $0.005–0.012 | small (Flash-Lite thinks less) |

### Monthly AI cost per user (estimates)
| Profile | Usage | 2.5 Flash | Flash-Lite |
|---|---|---|---|
| Free user, at limit | 7 captures × 30 s | **≈ $0.02** | ≈ $0.004 |
| Premium, typical | 100 captures × 1 min | ≈ $0.35 | ≈ $0.08 |
| Premium, heavy | 300 captures × 1 min | ≈ $1.05 | ≈ $0.25 |
| Premium, abusive (no cap) | 300 × 5 min | ≈ **$4.40**, close to the whole €4.99 price | ≈ $1.20 |
| **Today's code, one abusive free account** | no monthly cap; hourly limit bypassable | **unbounded** | unbounded |

**Conclusions:**
1. Normal usage is cheap. **7 free captures cost about 2 US cents a month**, so the free limit is a conversion lever, not a cost necessity.
2. **Unlimited premium is not safe.** Long recordings can cost almost as much as the subscription. Premium needs a fair-use cap on captures *and* audio minutes.
3. **The real risk is abuse, not normal users.** Today a single account can make paid calls without any monthly limit. That must be fixed before a paid key goes in (section 5).
4. Turning thinking off and evaluating **Flash-Lite** (on English, French *and* Kinyarwanda quality) could cut AI cost by roughly 4×.

## 3. Monthly operating cost scenarios (estimates)
| Phase | Fixed | AI (variable) | Total |
|---|---|---|---|
| **Development (now)** | $0: Vercel Hobby, Supabase Free | $0 on free tier with test data only, or cents on paid tier | **$0 – $1** |
| **Private beta, 50 testers** | $0 (if Hobby is acceptable for a non-commercial beta) | 50 × ~$0.05 ≈ $2.50 | **≈ $3** |
| **Commercial launch, 1,000 users (900 free, 100 premium)** | Supabase Pro $25 + Vercel Pro $20 = **$45** | 900 × $0.02 + 100 × $0.35 ≈ **$53** (Flash) or ≈ $12 (Flash-Lite) | **≈ $57 – $98** |

**Break-even estimate:** a €4.99 monthly subscription minus Stripe fees (~€0.36 on an EEA card) minus about €0.32 of AI leaves roughly **€4.30**, *before VAT*. If €4.99 includes VAT, net revenue is lower (for example about €4.16 at 20% VAT). Covering about $45 (≈ €41) of fixed costs takes roughly **10–12 premium subscribers**. This is an estimate, not a forecast, and **it is not profit**: it ignores VAT, income tax, refunds, support time and your own work.

## 4. Stripe fees (estimate, not active)
| | €4.99 monthly | €39.99 annual |
|---|---|---|
| Standard EEA card (1.5% + €0.25) + Stripe Billing 0.7% | ≈ €0.36 (7.2%) | ≈ €1.13 (2.8%) |
| International card (3.15% + €0.25) + 0.7% | ≈ €0.44 (8.8%) | ≈ €1.79 (4.5%) |

The fixed €0.25 makes small monthly payments relatively expensive, so the annual plan keeps far more of each payment. Currency conversion fees may apply on top. Note: the earlier proposal used €29.99 for the annual plan; this plan uses your new figure, **€39.99**.

## 5. Protections: what exists and what is proposed
| Protection | Status today | Proposal |
|---|---|---|
| API keys server-side only | ✅ Gemini key only in Supabase secrets; build refuses `VITE_*` secrets | keep |
| Per-user hourly rate limit | ✅ **fixed locally**: counted from the ledger users can't modify; failed calls count | — |
| Monthly AI cap per plan | ✅ implemented locally: free 7 captures; premium 300 captures **and** 600 min, enforced independently before any Gemini call | — |
| Max recording length | 5 min (client) + 12 MB (server) | per plan: free 2 min, premium 5 min, checked server-side by file size |
| Global daily/monthly AI budget | ✅ implemented locally ($2/day, $20/month hard stops) | stops AI calls when the estimated spend reaches the budget |
| Kill switch for AI features | ✅ implemented locally | one setting turns AI off instantly; manual notes and tasks keep working |
| "Test users only" mode | ✅ implemented locally (default) | while on the free Gemini tier, only admin/test accounts may use AI (protects real users' data) |
| Thinking tokens | ✅ disabled by default (setting) | set thinking budget to 0 for both calls; measure quality |
| Usage and cost recording | ✅ implemented locally | per-call ledger with real token counts from Gemini's response |
| Admin usage and finance dashboard | ✅ implemented locally | aggregates only, never users' note content |
| Sign-up abuse | email confirmation | add free CAPTCHA (Supabase supports Turnstile/hCaptcha) before public launch |

## 6. Provider-side safety nets (manual; free to configure; your action)

Step-by-step instructions: **`docs/GOOGLE_CLOUD_SAFETY.md`**.
These work even if our code has a bug:
1. **Google Cloud (when the Gemini key is created):**
   - Billing → **Budgets & alerts**: a monthly budget (for example $10) with emails at 50% / 90% / 100%. Budgets only *alert*; they don't stop spending.
   - APIs & Services → Generative Language API → **Quotas**: lower requests-per-minute and requests-per-day. This is a **hard cap**.
   - Restrict the API key to the Generative Language API only.
2. **Supabase Pro (at launch):** keep the **spend cap ON** (it's the default).
3. **Vercel Pro (at launch):** **Spend Management**: set a budget with notifications and the "pause projects" hard limit.
4. **Stripe (later):** fees are per transaction, so there's no runaway cost. Enable Radar rules and email receipts.

## 7. Privacy rules for AI processing (rule 12)
- **Free Gemini tier = test data only.** Google may use free-tier content to improve its products. Real users' recordings may only go to the paid tier (not used for training). Enforced by the proposed "test users only" setting.
- **Minimum data sent:** audio or transcript, date, timezone and category names. No email, name or user ID. Keep it that way.
- **Before real users arrive:** a privacy policy that names Google as a processor for transcription, consent at sign-up, review of Google's data processing terms and log-retention policy, and account deletion that removes all data (already implemented).
- **Kinyarwanda test recordings:** consent form names Google (see `docs/kinyarwanda/TEST_PLAN.md`).

## 8. Decisions needed from you (nothing is enabled without them)
1. Approve the financial control architecture (`docs/FINANCIAL_CONTROL_ARCHITECTURE.md`) for implementation.
2. Confirm the **free limit changes from "7 saved notes" to "7 AI voice notes"**, with manual notes unlimited (your new model). This replaces the current saved-notes limit.
3. Choose the premium fair-use cap (proposal: 300 AI captures and 600 audio minutes per month).
4. Set the budgets: a global daily AI budget (proposal: $2) and monthly (proposal: $20) during beta.
5. Later, and separately: enabling Gemini paid billing, Supabase Pro, Vercel Pro and Stripe all cost money and need your explicit approval.
