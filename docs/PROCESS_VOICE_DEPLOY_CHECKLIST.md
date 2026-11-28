# process-voice deployment checklist + real voice-test checklist

> See also `docs/PROCESS_VOICE_DEPLOY.md` (written in parallel by another session). Both agree; this file adds the live compatibility checks.

> **Update 23 Nov 2026:**
> - The branch HEAD has moved on. HEAD's `process-voice` calls migration-6 functions that don't exist live, so the **deploy target stays `3d8824e`**.
> - Pre-checks were re-run read-only at 19:23 UTC, and all pass: see `docs/VOICE_TEST_APPROVAL.md`.
> - The preview frontend (HEAD) is compatible with `3d8824e`: the request to process-voice is unchanged, and Capture falls back to `ai_available`.

## Context
The owner approved redeploying `process-voice`, `billing` and `delete-account`, then paused everything: **nothing more is deployed until the responsible adult who manages the Supabase project approves it.**

State at pause (2026-11-21 ~11:45 UTC):
- **`delete-account`: already redeployed** under the first approval → **v3, ACTIVE, verify_jwt=true**.
  - Verified: preview origin allowed; `evil.example` gets no Allow-Origin; a call without login returns 401.
  - Its rollback source is `d84c1b8` (byte-compared before deploying).
- **`billing`: still v2** (not deployed). It also waits for the adult's approval.
- **`process-voice`: still v2** (not deployed). This checklist covers it.
- **`stripe-webhook`: v1**, never to be touched.

Goal: replace `process-voice` v2 with the code at branch `claude/stripe-billing` HEAD `3d8824e` (CI green), safely and reversibly. Afterwards, guide the first real voice test.

## Pre-deployment facts (all checked read-only)
- **Being replaced:** project `nwglzabnezhmxfyuxhmg`, function `process-voice`, **v2**, ACTIVE, verify_jwt=true, 10 files.
- **Live v2 = git `d84c1b8`:**
  - Byte-compared: 9 of 10 files identical.
  - `_shared/extraction.ts` differs only in encoding: `​` written as a literal zero-width space, and no final newline. The resulting JavaScript string is identical.
- **Changes going live** (no other files change):
  - `process-voice/index.ts`: reads the key through `normaliseApiKey()` (`_shared/secrets.ts`, new file). It trims stray spaces, line breaks and quotes; refuses a key with whitespace inside; logs warnings that never contain the key.
  - `process-voice/provider.ts`: OpenAI error bodies pass through `redactSecrets()` before any log. OpenAI's 401 body echoes a masked key fragment (`sk-proj-***ab12`); it is removed.
  - `process-voice/handler.ts`:
    - OpenAI 401/403 → `503 ai_not_configured` (was `502 ai_unavailable`), with a setup hint in the logs (secret name, models to allow);
    - 404 → a model hint in the logs;
    - the reservation is still closed as `failed`, so the user is not billed.
  - `_shared/http.ts` + `_shared/cors.ts`: disallowed origins get no `Access-Control-Allow-Origin` (same fix as `delete-account`).
- **Database compatibility (live):**
  - `mvl_reserve_ai_capture(p_user, p_source, p_audio_seconds, p_provider, p_model)`, `mvl_record_ai_transcription(p_reservation, p_audio_seconds)`, `mvl_record_ai_call(p_reservation, p_audio_tokens, p_text_in_tokens, p_output_tokens, p_thinking_tokens)` and `mvl_finish_ai_capture(p_reservation, p_status, p_error_code)` all exist with exactly the argument names the code sends. Execute rights: service_role only (not authenticated, not anon).
  - Price book has `openai/gpt-transcribe+gpt-6-luna` and `openai/gpt-6-luna`, matching the code defaults, so AI does not fail closed.
  - No RPC, table or column changed between `d84c1b8` and HEAD. **No migration is needed.**
- **Frontend compatibility:** the response contract is unchanged; only one existing error code is reused.
  - `errors.ai_not_configured` already exists in `en` and `fr` (`src/lib/i18n.tsx`), and `i18n.test.ts` asserts it.
  - The Vercel preview needs no change.
- **Tests:** 71 Deno function tests (fakes for OpenAI and Supabase, real audio fixtures), 152 Vitest, `deno check` and `test:db` all green. CI green on `3d8824e`.

## Risks
1. **A working key starts costing money.** If `OPENAI_API_KEY` is set but was silently broken by pasted whitespace, it will start working.
   - Real OpenAI calls then cost money: tester account only (`ai_mode = admins_only`, 1 staff row), capped at $2/day and $20/month by the database.
   - Intended, but it is a behaviour change.
2. **Copying error during deploy.** The deploy tool takes file contents inline (~60 KB).
   - Mitigation: after deploying, fetch the live code and byte-compare every file with git HEAD.
   - Expected exception: `extraction.ts` may again show the harmless `​` encoding difference.
3. **Cold-start failure** (bad import): caught by the post-deploy health checks below; triggers rollback.
4. **No exposure of the key:** Claude never reads, prints or requests it.
   - The only key-related evidence is the startup log line "OPENAI_API_KEY is not configured" (present or absent). Claude reads that line, never a value.

## Deployment checklist (run only after the responsible adult approves)
1. ☐ Approval received in chat, naming `process-voice` (and `billing`, if also approved).
2. ☐ Re-check read-only: `process-voice` is still v2 and nobody redeployed it meanwhile. If not, stop and report.
3. ☐ Deploy `process-voice` from HEAD `3d8824e` with `mcp__Supabase__deploy_edge_function`:
   - entrypoint `process-voice/index.ts`, `verify_jwt=true`;
   - 11 files: `process-voice/{index,handler,provider}.ts` + `_shared/{audio-duration,cors,extraction,http,languages,secrets,transcription,usage}.ts`;
   - keep `​` as the escape sequence.
4. ☐ Verify the deploy:
   - `list_edge_functions` shows `process-voice` v3, ACTIVE, verify_jwt=true;
   - byte-compare the live files with git HEAD (via the saved tool-result file + python, as done for v2).
5. ☐ Health checks (curl through the proxy):
   - OPTIONS from the preview → 200 + Allow-Origin = preview;
   - OPTIONS from `https://evil.example` → no Allow-Origin;
   - POST without a token → 401;
   - Pricing still loads on the preview (unchanged `billing`).
6. ☐ Logs (`query_logs`, `function_edge_logs`, last 15 min): no boot error.
   - Note whether the line "OPENAI_API_KEY is not configured" appears. This is the only key evidence, and no value is shown.
7. ☐ Database untouched: `mvl_ai_usage` count, `voice_sessions` count, `ai_mode`, `mvl_staff` count and migration list are all unchanged.
8. ☐ Record in `docs/WORK_LOG.md` (versions, checks, results); commit and push to `claude/stripe-billing`.

**Rollback** (any failure in steps 4–6, done at once and reported):
- Redeploy `process-voice` with the 10 files in **`supabase/rollback/process-voice-v2/`**, `verify_jwt=true`. This is a byte-exact snapshot of the live v2, re-verified 10/10 against the live source on 21 Nov. Fallback: git `d84c1b8`, which is equivalent. Takes about 2 minutes.
- Then repeat steps 4–6 against the snapshot.
- No data, migrations or secrets are involved, so nothing else needs undoing.
- The same procedure applies to `delete-account`: redeploy from `d84c1b8`.

**Not done in any step:**
- read, request or print `OPENAI_API_KEY`, or any secret;
- change secrets, auth settings or Google sign-in (stays off);
- change `ai_mode`;
- grant roles;
- migrations or data edits;
- touch Stripe (stays test-only and unconfigured) or `stripe-webhook`;
- touch Vercel production or `main`;
- public launch.

## Real voice-test checklist (after deploy; owner on a laptop/desktop browser, Claude verifies read-only)
**Who:** the owner, signed in as the hen… account (the only tester), on a computer: Chrome or Edge first.
**Microphone:** the built-in laptop mic is fine. A headset gives cleaner audio. Close other apps that use the mic (Zoom, Teams, Discord), because they can block it.

> **This is the real OpenAI test.** Passing code and mock tests does NOT prove the integration works. Voice counts as working only when tests 2, 3, 5, 6, 8 and 14 pass with real recordings and real OpenAI calls.

**Preconditions:**
- the responsible adult has confirmed `OPENAI_API_KEY` is set in Supabase → Edge Functions → Secrets (name only; the value is never shared);
- Claude has noted the starting counts.

| # | Test | Expected | Claude verifies (read-only) |
|---|---|---|---|
| 1 | **Missing/invalid key path** (only if the key is NOT set yet) | Clear message "The AI service is not configured on the server yet." No fake result | Log shows "not configured"; 0 new `mvl_ai_usage` rows |
| 2 | **Transcription:** record ~10 s in English: "Remind me to call the school tomorrow at 9, and add a task to buy milk" | Review screen shows the transcript text matching what was said | `voice_sessions` +1 with a transcript; `mvl_ai_usage` +1 status `ok`, audio seconds ≈ 10 (server-measured) |
| 3 | **Extraction:** check the cards | A reminder "call the school" dated tomorrow 09:00 in your time zone; a task "buy milk". Nothing invented | — |
| 4 | **Ambiguous date:** "Meeting with Paul next week" | The event's date is empty and flagged; it cannot be saved without picking a date | — |
| 5 | **Review before save:** edit one card, reject another, accept the rest | Only accepted items are saved; the edit is kept | Rows appear in `tasks`/`reminders`/`events` for your user only; the rejected item is absent |
| 6 | **Refresh:** reload the app | Saved items persist; Memory search finds the transcript | — |
| 7 | **Multilingual:** one short sentence in French | Transcript in French; items extracted (quality marked unverified) | Detected language stored on the voice session |
| 8 | **Cost recording** | — | Cost for test 2 is a few tenths of a cent; tokens and seconds recorded; total within the $2/day cap |
| 9 | **Usage limit display:** Settings / Capture | Allowance shows the captures used (e.g. 3/7 free, or tester limits) | Matches `mvl_my_usage()` for that user |
| 10 | **Max length:** record past the plan's maximum (120 s on free) | Recording stops at the limit or the server refuses with a clear message; no charge beyond the limit | Reservation refused or audio seconds capped |
| 11 | **Silence:** record 5 s of silence | "No speech detected"-type message; nothing to save | Reservation finished `failed`/`no_speech` |
| 12 | **Mic denied:** padlock icon left of the address bar → Microphone → Block, reload, try to record (set it back to Allow afterwards) | A clear permission message with how to re-allow | — |
| 13 | **Network cut:** DevTools (F12) → Network tab → set throttling to **Offline**, then stop a recording so it uploads (set back to No throttling afterwards) | A clear error; no half-saved items; retry possible | No orphan `reserved` row older than 15 min (expires by design) |
| 14 | **Secret protection** | — | Logs for the test window contain no `sk-`, no `Bearer`, no JWT (search `function_edge_logs` for those patterns, reporting counts only); the DevTools Network tab (F12) shows no key in any response from `process-voice` |
| 15 | **Non-tester refusal** (optional, needs a second account) | "AI is not available for your account yet"-type message | Reservation refused with `admins_only`; no OpenAI call |

**Pass criteria:** tests 2, 3, 5, 6, 8 and 14 must pass before inviting any beta user to use voice. Any ❌ → Claude diagnoses from logs and DB (read-only) and proposes a fix; nothing changes without approval.

## Short owner test (6 steps, about 10 minutes)
On a computer first (Chrome or Edge), signed in with the owner's account. Then the iPhone (Safari / installed app).
1. **Capture → record ~10 s:** "Remind me to call the school tomorrow at 9, and add a task to buy milk." → the transcript appears.
2. **Check the cards:** a reminder for tomorrow at 09:00 and a "buy milk" task. Nothing invented.
3. **Edit one card, reject another, save.** → only the accepted items are saved.
4. **Reload the page** → the items are still there; Memory finds the transcript.
5. Claude checks, read-only: the cost is recorded (a fraction of a cent), within the budget.
6. Claude checks, read-only: no key, `Bearer` or JWT in the logs (counts only).

Steps 1–4 ✅ plus checks 5–6 ✅ = voice works for real. Any ❌ → send a screenshot plus the Console errors (F12); Claude diagnoses read-only.
