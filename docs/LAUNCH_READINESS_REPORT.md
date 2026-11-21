# Launch readiness report — My Voice Life

**Target:** 21 November 2026, 23:00 (France)
**Prepared:** 21 November 2026, from branch `claude/stripe-billing` (draft PR #4)
**Method:**
- read-only checks of the live Supabase project `nwglzabnezhmxfyuxhmg` (SQL, auth logs, security advisor);
- the full automated suite;
- Chromium runs against a mocked backend at 360 / 390 / 768 / 1366 px.

**Limits of this report (read first):**
- Claude in Chrome was **not connected** to this session. A headless Chromium was used instead.
- **Live** (real preview + real Supabase) tests cover everything **outside sign-in**: public pages, auth errors, Google state, Pricing → `billing`, headers, CORS, function auth. Network access was granted later on 21 Nov.
- **Nothing behind sign-in has been tested live:** no test account was available. Those flows are mock-tested only.
- No real Google, OpenAI or Stripe call was made.
- Everything marked "tested" below was tested with mocks unless it says *live*.

## Verdict

**A public launch at 23:00 tonight is not safe.** Three core promises are not working live:
- **Google sign-in** is disabled in Supabase.
- **AI voice** has never completed a single real capture: 0 usage rows, and the `OPENAI_API_KEY` secret is unconfirmed.
- **Payments** have no Stripe account configured.

The legal pages are drafts with the owner's identity missing. Launching publicly without them would be the riskiest item of all.

**What is realistic tonight:** a **private beta for invited people**. They can:
- sign up with email and password;
- create notes, tasks, reminders and events by hand;
- search their memory;
- delete their account.

Voice stays limited to the tester account (`admins_only`), and nothing is sold. That part is built, tested and live-deployed.

## Status by area

Priority: **CRITICAL** blocks any public launch · **HIGH** blocks a paid/public launch · **MEDIUM** fix soon after · **LOW** polish.

### A. Authentication
| Item | Status | Priority | Evidence / action |
|---|---|---|---|
| Email/password sign-up, confirm, login, reset | ✅ live | — | 2 confirmed users created through the real flow (auth logs) |
| Google sign-in | 🔴 **not working live** | HIGH | **Cause proven:** live auth logs show `400 "provider is not enabled"` on every `/authorize?provider=google`; only `email` identities exist. **Code fixed:** the button is hidden while the provider is disabled (no more raw JSON error page). With the provider on, the button navigates to the right authorize URL and cancel/refusal shows a readable message (mock-tested). **Owner must do:** the steps in `docs/GOOGLE_OAUTH_SETUP.md` (Google Cloud web client with redirect URI `https://nwglzabnezhmxfyuxhmg.supabase.co/auth/v1/callback`; enable Google in Supabase with that client ID and secret; check the redirect allowlist). **Not fixed until a real Google login succeeds.** |
| Leaked-password protection | ⚠️ off | MEDIUM | Security advisor. Owner toggle: Supabase → Auth → Passwords |
| Two confirmed accounts for the same person ("hen…" kept, "oli…" also confirmed) | ⚠️ | LOW | Owner decides whether to delete "oli…"; Claude will not delete data without permission |

### B. AI voice assistant
| Item | Status | Priority | Evidence / action |
|---|---|---|---|
| End-to-end capture (record → transcribe → review → save) | 🟡 never run live | CRITICAL for a voice launch | 0 rows in `mvl_ai_usage` and 0 `voice_sessions`. Proven offline only: 71 Deno function tests (real recordings, faked OpenAI), mocked browser runs |
| `OPENAI_API_KEY` secret | ❓ unknown | CRITICAL | No tool here can list secret names. Responsible adult checks Supabase → Edge Functions → Secrets. If it is missing, a capture returns "AI not configured", at no cost |
| Deployed `process-voice` is behind the branch | ⚠️ | HIGH | Live v2 lacks commit `cbec0c4` (key-whitespace tolerance, log redaction, 401/403 → "not configured"). **Needs the owner's approval to redeploy** |
| No fake output; nothing saved without review; audio not stored; dates never invented | ✅ | — | Unit and Deno tests; CLAUDE.md rules 4–6 |
| Spending guards (allowance, rate limits, $2/day, $20/month, kill switch, `admins_only`) | ✅ live in DB | — | Migrations applied; DB tests incl. a race test |
| Voice quality in any language | ⬜ unverified | HIGH | No native-speaker evaluation yet; the UI says "unverified" |

### C. Payments (Stripe, test mode only)
| Item | Status | Priority | Evidence / action |
|---|---|---|---|
| Schema, `billing`, `stripe-webhook`, delete-account cancellation | ✅ deployed | — | Migration 5 applied; functions ACTIVE; Deno and DB tests |
| Stripe test account, prices, webhook, secrets | ⬜ not configured | HIGH (for selling) | Needs the responsible adult (`docs/STRIPE_SETUP.md`). Until then the Pricing page honestly says "not available", and 0 Stripe events exist |
| Live payments | 🚫 refused by design | — | `STRIPE_LIVE_MODE_APPROVED` not set; Claude will not set it |

### D. Database and security
| Item | Status | Priority | Evidence |
|---|---|---|---|
| RLS on every public table | ✅ live | — | 0 tables without RLS (live query); owner-only policies; `test:db` green |
| Financial tables writable only via SECURITY DEFINER RPCs | ✅ | — | Advisor "RLS enabled, no policy" on 8 `mvl_*` tables is intended (no direct client access) |
| Admin RPCs callable by signed-in users | ✅ intended | LOW | Advisor warning; each one checks `mvl_is_admin()` itself (DB tests). Tester account: `is_admin` false |
| `rls_auto_enable()` callable by anon | ✅ harmless | LOW | Supabase's own event-trigger helper (not ours); returns `event_trigger`, so it cannot be called directly |
| No secrets in the browser | ✅ | — | Build secret guard runs on every build |
| CORS | ⚠️ | MEDIUM | Uses the preview wildcard `my-voice-life-*-henry7.vercel.app` as a code default (secret storage was paused). Replace with the exact production domain before going public |

### E. Privacy and legal
| Item | Status | Priority | Action |
|---|---|---|---|
| Privacy policy `/privacy`, terms `/terms` | 🟡 **drafts** | CRITICAL for public launch | Content matches the code (audio not stored, OpenAI processing, processors, deletion). Linked from landing, register, pricing and settings. **Owner must supply:** legal identity, contact, server regions and transfers, legal basis, minimum age, refunds, VAT, governing law, then a legal review. Nothing was invented |
| Capture screen disclosure | ✅ | — | Now names OpenAI explicitly (en, fr) |
| French versions of legal texts | ⬜ | HIGH for French users | Needs a reviewed translation |
| Data export | ⬜ | MEDIUM | Not built; the policy says to ask by email |

### F. User experience
| Item | Status | Priority | Evidence |
|---|---|---|---|
| No horizontal overflow, no console errors, all links resolve | ✅ mock-tested | — | 14 pages × 4 widths (360/390/768/1366) |
| Tap targets | ✅ fixed | — | "Mark as done" and the category/language remove buttons enlarged to ≥ 24 px without layout change |
| Real phones (iOS Safari, Android Chrome), real microphone | ⬜ | HIGH | Not possible from this session |

### G. Automated checks (this commit)
| Check | Result |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npx vitest run` | ✅ 151 / 151 |
| `npm run build` (with secret guard) | ✅ pass |
| `deno check` all functions | ✅ pass |
| `npm run test:functions` | ✅ 71 passed, 0 failed |
| `npm run test:db` (RLS, financial, multilingual, billing, upgrade, guard) | ✅ 0 failures |
| GitHub CI on PR #4 | runs on every push; see the PR |

### H. Deployment
| Item | Status | Priority |
|---|---|---|
| Vercel preview | ✅ builds from the branch | — |
| Production (`main`) | not deployed; needs owner approval and merge of PRs #3 and #4 | — |
| Error monitoring | ⬜ none | MEDIUM |
| Custom SMTP for auth emails | ⬜ Supabase default mailer (rate-limited) | HIGH for public sign-ups |

### I. Real-user testing
**Live, outside sign-in (headless Chromium, 21 Nov):**
- 9 public pages × 4 widths: no overflow, no console errors.
- `/app` redirects to login.
- Google button hidden.
- Wrong-password message is clear.
- Registration validation works.
- Pricing loads the real `billing` function.
- Security headers present.
- CORS correct for the preview.
- `process-voice` refuses unauthenticated calls (401).
- The webhook refuses calls (503, not configured).

**Found live and fixed in code (needs an approved redeploy):** the CORS fallback echoed a pattern string to disallowed origins.

**Not performed:** signed-in flows (notes/tasks/reminders/events CRUD, persistence, settings, deletion, voice, checkout). There is no test account; Claude did not create one in production without your decision. **The owner should do a 15-minute pass on a phone** before inviting anyone:
- sign up;
- create one of each item;
- search;
- open Pricing, Privacy and Terms;
- (tester account only) record one voice capture once the key is confirmed.

### J. Owner actions, in order
1. **Tonight (private beta):** decide whether invited users are acceptable with draft legal pages (recommended: no public link, invite only).
2. Confirm `OPENAI_API_KEY` in Supabase secrets (responsible adult). Then approve the `process-voice` redeploy from `cbec0c4`, and do one real capture on the tester account.
3. Google: the steps in `docs/GOOGLE_OAUTH_SETUP.md`, then one real Google login. I'll verify `auth.identities` afterwards (read-only).
4. Complete the legal placeholders and get them reviewed.
5. Turn on leaked-password protection; set up custom SMTP.
6. Stripe test account (responsible adult) → test checkout with a Stripe test card → verify the webhook row.
7. Only then: production domain, exact CORS origin, merge, and production deploy (each with explicit approval).
