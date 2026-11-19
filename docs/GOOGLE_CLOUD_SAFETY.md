# Google Cloud / Gemini safety setup

Owner's checklist. **Nothing here has been done for you, and nothing here enables paid billing.** Enabling Gemini paid billing, and adding a real key to the project, both require the owner's explicit approval. Google's console menus change, so if a label below doesn't match exactly, look for the nearest equivalent.

Defence in depth, from fastest to slowest to act:
1. **The app's own controls** (already built): per-user allowances, rate limits, a $2/day and $20/month hard budget, the admin kill switch, and staff-only test mode.
2. **Google API quotas:** a hard cap enforced by Google, even if our code had a bug.
3. **Google Cloud budget alerts:** emails only; they never stop spending.
4. **Emergency shutdown:** remove the key, disable the API, or unlink billing.

## 1. Create an isolated project and key
1. In Google Cloud Console, create a project **just for My Voice Life**. Don't share it with Photosentry or other apps; separate projects keep budgets, quotas and keys separate.
2. In Google AI Studio, choose **Get API key → Create key in existing project** and select that project.
3. **Restrict the key:** Cloud Console → APIs & Services → Credentials → the key → **API restrictions → Restrict key → Generative Language API** only. (An IP restriction isn't practical because Supabase Edge Functions have no fixed IP.)
4. Store the key **only** as a Supabase secret: Dashboard → Edge Functions → Secrets → `GEMINI_API_KEY`. Never in chat, GitHub, Vercel or a `VITE_` variable.

## 2. Hard caps: API quotas (strongest protection)
Cloud Console → APIs & Services → **Generative Language API** → **Quotas & system limits**. Filter by the model you use (default `gemini-2.5-flash`) and lower the **requests per minute** and **requests per day** quotas.

Each voice capture makes 1 free `countTokens` call plus 2 `generateContent` calls; a typed capture makes 1 `generateContent` call.

| Phase | Suggested generateContent requests/day | Suggested requests/minute | Why |
|---|---|---|---|
| Private testing (now) | **100** | **10** | about 50 captures/day, enough for staff testing |
| Beta | **300** | **30** | about 150 captures/day. At a typical ~$0.0023 per capture that's about $0.35/day, well under the $2 app budget. Even at the worst-case ~$0.031, the app's budget stops first (about 64 captures) |
| After launch | set from **measured** usage in the admin dashboard | | |

If Google's quota stops a request, the app shows "The AI service is busy" and **saves nothing**, so no data is lost.

## 3. Budget alerts (monitoring, not a cap)
Cloud Console → **Billing → Budgets & alerts → Create budget**:
- **Scope:** the My Voice Life project only. Optionally filter by service: *Generative Language API*.
- **Amount:** a monthly budget of **$20**, matching the app's monthly AI budget.
- **Thresholds:** 50%, 90%, 100% of **actual** spend, plus 100% of **forecasted** spend.
- **Notifications:** email billing admins and users. Add your own email.

**Important:** Google budgets **only send alerts. They don't stop charges.** The hard stops are the app budget and the API quotas.

**Daily monitoring:** Google budgets are monthly. For daily control:
- **The app** enforces the **$2/day** budget itself and shows today's spend in **Admin → AI controls**. Optionally set the `ALERT_WEBHOOK_URL` secret (a Slack, Discord or similar incoming webhook; free) to get a message when a threshold is crossed. The message contains no user data.
- **Google:** Billing → Reports, grouped by **day** and filtered to the project, shows actual daily cost (with some delay).

## 4. Monthly review (10 minutes)
1. Compare **Google's invoice** for the month with **Admin → Finances → AI costs**, which is an estimate from recorded tokens. They should be close. A large gap means the price book is out of date or something isn't being recorded.
2. Enter the real invoice amounts as **actual** expenses in **Admin → Operating expenses**: Supabase, Vercel, Google, domain.
3. If Google changed its prices, add a new row to `mvl_price_book` with a new `effective_from` date (SQL editor). Never edit past rows: they describe past costs.
4. Before commercial launch, measure the real average cost per capture (Admin → AI usage → estimated cost ÷ captures). Recalculate whether the premium allowance (300 captures / 600 minutes) is sustainable at €4.99.

## 5. Emergency shutdown (fastest first)
| Step | Effect | How |
|---|---|---|
| 1. **App kill switch** | Instant. All new AI requests are refused; notes and tasks keep working | Admin → AI controls → **Off (emergency stop)** |
| 2. Delete or rotate the API key | All Gemini calls fail within minutes | AI Studio → API keys → delete, or Cloud Console → Credentials |
| 3. Disable the API | No calls possible from the project | Cloud Console → APIs & Services → Generative Language API → **Disable** |
| 4. Unlink billing | Stops **all** paid services in that project | Billing → Account management → disable billing on the project |

After an incident: check Admin → AI usage (refusal reasons, top users by pseudonymous ID) and the Edge Function logs. Rotate the key before turning AI back on.

## 6. Privacy rules that go with this setup
- **Free Gemini tier = test data only.** Per Google's pricing page, free-tier content may be used to improve Google's products. The app therefore starts in `admins_only` mode: only staff and testers can use AI. Real users stay blocked until you switch the mode to `on`, which you should do only after paid billing **and** the privacy review are approved.
- Data sent to Gemini: audio or transcript, today's date, the time zone and category names. **No** email, name or user ID.
- Before opening AI to real users: a privacy policy naming Google as processor, consent at sign-up, and a review of Google's data processing terms and log retention.
