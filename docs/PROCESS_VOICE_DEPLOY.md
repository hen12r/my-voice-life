# `process-voice` redeploy: checklist, rollback and real voice test

**Status: prepared, NOT deployed.** It needs explicit approval from the responsible adult who manages the Supabase project. Prepared on 2026-11-21 from `claude/stripe-billing`. Every check below was read-only.

## 1. What would be replaced
| | Live now | After deploy |
|---|---|---|
| Function | `process-voice`, id `2b7f1de7-a22b-41c2-9108-47878c869cb0` | same function, **new version 3** |
| Version | **2**, ACTIVE, deployed 2026-11-20 ~20:39 UTC | 3 |
| Bundle sha256 | `5c90ea5df97a…d86d5e` | new |
| Source | branch at `d84c1b8` (exact copy in `supabase/rollback/process-voice-v2/`) | branch head, which includes `cbec0c4` and `3ecbc81` |
| `verify_jwt` | true | **true** (must not change) |

**Files that change (5 files, about 40 lines):**
- `process-voice/index.ts`, `provider.ts`, `handler.ts`: key read with paste-tolerance, error text redacted, 401/403 → `ai_not_configured` with a setup hint in the log (`cbec0c4`).
- `_shared/secrets.ts` (new): the helpers for the above.
- `_shared/cors.ts`, `_shared/http.ts`: a disallowed origin now gets **no** `Access-Control-Allow-Origin` header, instead of a pattern string (`3ecbc81`, the same fix already live in `delete-account` v3).

**Unchanged:** `transcription.ts`, `languages.ts`, `audio-duration.ts`, `usage.ts`, `extraction.ts` (one character spelled differently, same behaviour), the request/response format, the models, the prices and every database call.

**Nothing else is touched:** no other function, no migration, no secret, no setting, no user data, no Vercel or `main` change. Stripe, Google sign-in and public launch stay off.

## 2. Compatibility (checked read-only on 2026-11-21)
| Check | Result |
|---|---|
| Database functions | ✅ All 4 RPCs the code calls exist live with the same parameter names: `mvl_reserve_ai_capture(p_user, p_source, p_audio_seconds, p_provider, p_model)`, `mvl_record_ai_transcription(p_reservation, p_audio_seconds)`, `mvl_record_ai_call(p_reservation, p_audio_tokens, p_text_in_tokens, p_output_tokens, p_thinking_tokens)`, `mvl_finish_ai_capture(p_reservation, p_status, p_error_code)`. Only `service_role` can execute them, not `authenticated`. These calls are byte-for-byte the same as in v2 |
| Tables | ✅ `voice_sessions`, `categories` (unchanged from v2) |
| Prices | ✅ `mvl_price_book` has `gpt-transcribe+gpt-6-luna` and `gpt-6-luna` rows, matching the defaults |
| Frontend | ✅ Same request (multipart audio or JSON text) and same response format. The only new outcome is `ai_not_configured` on a refused key, an existing code already translated in en/fr (a test checks every backend code has a message) |
| Secrets | ✅ Same names as v2: `OPENAI_API_KEY`, optional `OPENAI_*_MODEL`, `ALERT_WEBHOOK_URL`, `ALLOWED_ORIGINS` |
| AI access | ✅ `ai_mode = admins_only`, 1 staff row (`tester`), 0 AI usage rows. A redeploy changes none of this |
| Tests at branch head | ✅ Vitest 152/152, Deno function tests 71/71, `deno check` and `tsc` clean. OpenAI is **faked** in every test |

## 3. Deployment checklist
**Before** (needs approval)
- [ ] The responsible adult approves deploying `process-voice` from `claude/stripe-billing` at a named commit (head when approved: `3d8824e` + this doc).
- [ ] CI is green on that commit (GitHub `test` check and Vercel).
- [ ] Re-read the live version number. It must still be **2**, with sha `5c90ea5df97a…`. If it changed, stop and recompare.

**Deploy**
- [ ] Deploy only `process-voice`, with `verify_jwt: true`, including `_shared/secrets.ts`, `cors.ts`, `http.ts` and the other `_shared` files it imports.

**Right after** (no AI cost)
- [ ] `list_edge_functions`: `process-voice` is version 3, ACTIVE, `verify_jwt` true. The other 3 functions are unchanged (`billing` v2, `delete-account` v3, `stripe-webhook` v1).
- [ ] A call with no sign-in returns **401**.
- [ ] A preflight from the preview origin returns that origin in `Access-Control-Allow-Origin`. A preflight from `https://example.com` returns **no** such header.
- [ ] Logs show no errors at startup. If the key is missing, they show "OPENAI_API_KEY is not configured", which is expected and never shows a value.

## 4. Rollback (about 2 minutes)
Do this if anything above fails, or if voice behaves worse than before.
1. Redeploy `process-voice` with exactly the files in `supabase/rollback/process-voice-v2/` (folder layout: `process-voice/…` and `_shared/…`) and `verify_jwt: true`. Supabase will name it version 4. That's normal: the *content* is version 2.
2. Check: version ACTIVE, `verify_jwt` true, an unauthenticated call → 401.
3. No database step is needed. This change has no migration, and the database calls are identical in both versions.

Optional: compare the bundle sha. Supabase may produce a different `ezbr_sha256` for identical source, so the file contents are what count.

## 5. Real voice test (after deploy, and once the adult has saved `OPENAI_API_KEY`)
Use the tester account on `https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app`, on a phone. Real OpenAI calls cost about **$0.005 per minute** of audio. The app's own limits are $2/day and $20/month.

**A. Transcription and extraction**
- [ ] Record about 10 s in English: "Tomorrow at 10 I need to call my school, and buy a notebook." → transcript matches. Cards: a reminder or task for tomorrow at 10:00 *and* a task to buy a notebook.
- [ ] Record about 10 s in French: "Demain je dois appeler le dentiste." → French transcript, a task dated tomorrow.
- [ ] Record without a date: "I should read more books." → a note or task with **no** date invented.
- [ ] Mixed or vague ("sometime next week…") → the date is left empty or flagged, not made up.

**B. Review and saving**
- [ ] Nothing appears in Tasks or Notes before you accept.
- [ ] Edit one card, reject one, accept the rest → only the accepted ones appear, with your edits.
- [ ] A reminder without a date can't be saved.

**C. Usage and limits** (I check read-only after each step)
- [ ] One `mvl_ai_usage` row per capture: status `ok`, `audio_seconds` ≈ the recording length, cost under $0.01.
- [ ] `voice_sessions` row `extracted` → `committed` after saving.
- [ ] Settings shows captures and minutes used going up.
- [ ] Silence or a 1 s recording → refused with "no speech", and the allowance isn't used.

**D. Errors** (no cost)
- [ ] Before the key exists: a capture shows "AI not configured" right away, and no usage row is created.
- [ ] Turn off the network during processing → a readable error, and nothing saved.
- [ ] An account that isn't staff (if you have a second test account) → `ai_test_mode`, at no cost.

**E. Secret protection**
- [ ] Browser DevTools → Network: no request from the browser goes to `api.openai.com`. The only call is to `…supabase.co/functions/v1/process-voice`.
- [ ] Search the built JavaScript for `sk-`: no match (the build guard also checks this).
- [ ] Supabase → `process-voice` → Logs: no key and no `sk-…` fragment, only redacted text.
- [ ] No transcript text or audio appears in the logs.

**If something fails:** note the error code shown in the app and the time, and tell me. I'll read the logs and the usage table (read-only) and say exactly what happened.
