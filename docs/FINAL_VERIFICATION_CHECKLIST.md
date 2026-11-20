# Final technical verification checklist

**Checked read-only on 2026-11-20 at about 20:40 UTC**, against Supabase project `nwglzabnezhmxfyuxhmg`. Nothing was changed during the check.

## Done and verified
| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `process-voice` deployed | ✅ yes | Edge Functions list: version 2, ACTIVE, JWT verification on. `billing` (v2), `delete-account` (v2) and `stripe-webhook` (v1) are also ACTIVE |
| 3 | Test account has voice-testing rights, and no admin rights | ✅ yes | `mvl_staff` has exactly 1 row: role `tester`, user `3c30d720…` (the confirmed hen… account). As that user: `is_staff` true, `is_admin` false, `mvl_is_admin()` false, `ai_available` true. `ai_mode` stays `admins_only` |
| — | Database ready for voice and billing | ✅ yes | migrations 1–5 applied; 2 OpenAI price rows; billing functions callable by the service role only |
| — | Browser origin (CORS) | ✅ in code | the preview origin is the built-in default (secret storage was paused). Not yet seen working from a real browser |

## Not verifiable from here
| # | Check | Status | How to check |
|---|---|---|---|
| 2 | `OPENAI_API_KEY` configured | ❓ **unknown** | No available tool lists secret names, and Supabase reported "Storing keys is paused". Supabase Dashboard → Edge Functions → Secrets shows names only, never values. During a capture, the error `ai_not_configured` means the key is missing |

## Blocked by external configuration
| # | Check | Status | Blocked by |
|---|---|---|---|
| 4 | Voice pipeline live: recording → transcription → AI → review → save | ⬜ **never run live** | `OPENAI_API_KEY`, which an adult must add. Live state: 0 `mvl_ai_usage` rows, 0 `voice_sessions`, 0 function calls in the last 24 h. Proven **offline only**: 27 Deno tests with real recordings and fake OpenAI, plus mocked browser runs (record → upload → review → edit/accept → save) |
| 5 | Stripe test mode | ⬜ **code ready, not configured** | an adult-owned Stripe test account; a product and prices; the Customer Portal; the webhook endpoint; Supabase secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PREMIUM_MONTHLY` (`docs/STRIPE_SETUP.md`). Live: 0 Stripe events, no customers |

## Live voice test, once the key exists
1. Confirm `OPENAI_API_KEY` appears under Supabase → Edge Functions → Secrets.
2. Open the preview on a phone and sign in with the hen… account.
3. Capture: record about 10 s, for example "Tomorrow I need to call my school and prepare my CV".
4. Check the review cards. Accept them, then save.
5. Ask me to verify, read-only:
   - one `mvl_ai_usage` row with status `ok` and a cost of a few tenths of a US cent;
   - one `voice_sessions` row with status `extracted`;
   - the new tasks in Tasks.

| What you see | Meaning |
|---|---|
| `ai_not_configured` | the key is missing |
| `ai_test_mode` | the tester row isn't being read |
| a CORS or network error | report it, with the preview URL |

## Verdict
**Not ready for real users yet.** The code, the database, the deployments and the permissions are in place and tested offline. What's missing is external configuration (the OpenAI key, Stripe test setup) and the first live voice test on a real phone.
