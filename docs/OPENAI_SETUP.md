# OpenAI setup (voice → transcript → organised items)

This page is for the **responsible adult** who manages the OpenAI account, and for anyone checking that the integration is ready. The code is ready. **The only missing piece is the `OPENAI_API_KEY` secret in Supabase.** Nobody ever needs to send the key to anyone: it is typed directly into the Supabase dashboard and stays there.

## Status (checked read-only on 2026-11-20)
| Item | State |
|---|---|
| `process-voice` Edge Function | ✅ deployed and active on Supabase `my-voice-life` (`nwglzabnezhmxfyuxhmg`), JWT verification on |
| Database (migrations 1–5, OpenAI price rows) | ✅ applied |
| Owner's test account | ✅ `tester` role (can use AI while it is staff-only; not an admin) |
| Browser origin (CORS) | ✅ Vercel previews of this project are allowed by default; production needs `ALLOWED_ORIGINS` |
| **`OPENAI_API_KEY` secret** | ❌ **not set**: Edge Functions → Secrets shows "No custom secrets created" |
| Live voice capture | ⬜ never run. Every capture currently gets `ai_not_configured`, before any cost |

Once the key is saved, voice capture works on the next request. The function reads secrets when it starts, so nothing needs redeploying.

> **What has and has not been tested.** The pipeline (measure → reserve → transcribe → record → extract → record → finish) is covered by 30 automated tests. They use **fake** OpenAI replies, shaped like OpenAI's documented responses, plus real browser recordings. These fakes are **not** real OpenAI output. No request has ever reached OpenAI from this project. Transcription quality and extraction quality can only be judged after the first live tests.

## How the key is handled in the code
- **Read only on the server.** `supabase/functions/process-voice/index.ts` reads `Deno.env.get('OPENAI_API_KEY')` once, inside the Edge Function. It is never in the repository, Vercel, a `VITE_*` variable, or the browser bundle. The build refuses to start if a `VITE_*` variable looks like a key.
- **Pasting mistakes are tolerated.** Spaces, a trailing line break or surrounding quotes are removed (`_shared/secrets.ts`, `normaliseApiKey`). A key with a space or line break *inside* it is refused, because it could never work. Startup warnings describe the problem and never include any part of the key.
- **Sent only to OpenAI.** The key is used only in the `Authorization` header of requests to `https://api.openai.com/v1`. A test checks it never goes to any other address and never appears in a response.
- **Never logged.** OpenAI's "wrong key" error message echoes a masked fragment of the key, so every upstream error text is passed through `redactSecrets` before logging. Tests check the logs contain no key fragment.
- **The browser gets generic messages.** The browser only receives an error code (for example `ai_not_configured`). Configuration details stay in the server logs.
- **Missing key = no cost.** Without a key, a signed-in user gets `ai_not_configured` before any reservation or paid call. Anonymous callers get `401` and learn nothing about the configuration.

## The pipeline (verified against developers.openai.com on 2026-11-19 and 2026-11-20)
| Stage | What happens | Model and endpoint | Price (in `mvl_price_book`) |
|---|---|---|---|
| 1. Measure | The recording's real length is read from the file (WebM/Ogg/MP4). A client can't under-declare it | none | free |
| 2. Reserve | `mvl_reserve_ai_capture` checks allowance, rate limits, daily and monthly budget, kill switch and staff-only mode, and holds the worst-case cost | none | free |
| 3. Transcribe | Audio → text, with up to 3 expected languages as hints (retried once without hints if OpenAI rejects them) | `gpt-transcribe`, `POST /v1/audio/transcriptions` | $0.0045 per minute |
| 4. Extract | Transcript → notes, tasks, reminders and events, using a **strict JSON schema** (Structured Outputs), `reasoning.effort: "none"`, `store: false` and an output-token cap | `gpt-6-luna`, `POST /v1/responses` | $0.10 / $0.50 per 1M input/output tokens |
| 5. Validate | `validateExtraction` cleans every item: no invented dates, unknown categories dropped, bounded lengths | none | free |
| 6. Review | The app shows proposals. **Nothing is saved until the user accepts each item** | none | free |

Each paid call records its real usage (seconds, tokens). Failures close the reservation, and the monthly allowance isn't used. If the cost tracking itself fails, the reservation expires at its worst-case cost, so spend is never under-counted. A typical one-minute note costs about **$0.005**.

## Setup steps (responsible adult)

### 1. OpenAI account and key
1. Sign in at **platform.openai.com**. The API terms require an adult account holder.
2. **Billing:** add a small prepaid credit, for example $5–10. These models have no free tier.
3. **Limits:** set a monthly budget and an email alert under Settings → Billing → Limits. OpenAI's limit may only notify you. The app's own $2/day and $20/month budgets are what actually block spending.
4. Create a **project** named "My Voice Life", then an **API key restricted to that project**.
5. Recommended: in the project's model settings, allow only `gpt-transcribe` and `gpt-6-luna`. If you do, keep both allowed. Blocking either one makes captures fail with `ai_not_configured`, and the logs explain why.

### 2. Save the secret in Supabase (the only step the app still needs)
1. Open **https://supabase.com/dashboard/project/nwglzabnezhmxfyuxhmg/functions/secrets**.
2. Under **Add or replace secrets**: Name = `OPENAI_API_KEY`, Value = paste the key.
3. Click **Save**. The key should then appear under "Custom secrets", with a digest and a date. Supabase never shows the value again.

**Never** paste the key into chat (including with an AI assistant), GitHub, Vercel, an email, a screenshot or any file in the repository. If it was exposed, revoke it on platform.openai.com and create a new one.

Optional secrets (normally leave them unset):
| Name | When to set it |
|---|---|
| `ALLOWED_ORIGINS` | **before production**: the exact production address, e.g. `https://my-voice-life.vercel.app`. Without it, only this project's Vercel previews and `localhost:3000` are allowed |
| `ALERT_WEBHOOK_URL` | a webhook that receives budget alerts (no user data is ever sent) |
| `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_TEXT_MODEL` | only to switch models. Add matching `mvl_price_book` rows **first**, or AI fails closed with `ai_price_unknown` |

### 3. Check it works (about 2 minutes)
1. Open the latest preview: `https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app`. Sign in with the tester account.
2. Go to **Speak** and record about 10 seconds, for example "Tomorrow at 10 I need to call my school, and I have to buy a notebook."
3. Expected: a transcript, then review cards (a task or reminder dated tomorrow, and a task to buy a notebook). Accept them and save, then check Tasks and Schedule.
4. Read-only database checks (SQL editor, or ask the assistant):
   ```sql
   select status, provider, model, audio_seconds, est_cost_usd from public.mvl_ai_usage order by occurred_at desc limit 3;
   -- expect: status ok, provider openai, audio_seconds ≈ the recording length, cost well under $0.01
   select status, detected_language from public.voice_sessions order by created_at desc limit 3;
   -- expect: status extracted (or committed once items were saved)
   ```

## Troubleshooting
| What the app shows | Server log says | What to do |
|---|---|---|
| `ai_not_configured` right away | "OPENAI_API_KEY is not configured" | The secret is missing or empty. Repeat step 2 |
| `ai_not_configured` after recording | "OpenAI refused the request (HTTP 401)" | The key is wrong or revoked. Create a new key and replace the secret |
| `ai_not_configured` after recording | "OpenAI refused the request (HTTP 403)" | The key's project doesn't allow `gpt-transcribe` or `gpt-6-luna`. Allow both models (step 1.5) |
| `ai_unavailable` | "OpenAI returned 404" | A model name doesn't exist for this key. Remove any `OPENAI_*_MODEL` overrides |
| `ai_busy` | 429 | OpenAI rate limit or no credit left. Check billing on platform.openai.com |
| `ai_test_mode` | — | The account isn't staff while AI is staff-only. Check the `mvl_staff` row |
| `quota_*`, `rate_limited_*`, `budget_*` | — | One of the app's own limits stopped the request, before any cost |
| `unsupported_audio` | — | The recording isn't WebM/Ogg/MP4, so its length couldn't be checked |
| `ai_timeout` | — | OpenAI didn't answer in time. The measured length is still booked as spend |
| a CORS or network error in the browser | — | The page's address isn't allowed. Use a preview of this project, or set `ALLOWED_ORIGINS` |

Server logs: Supabase → Edge Functions → `process-voice` → Logs. They never contain the key.

## Running the automated tests
```bash
npm test                 # Vitest: includes _shared/secrets.test.ts (key reading and redaction)
npm run test:functions   # Deno: process-voice orchestration with FAKE OpenAI/Supabase and real recordings
```
The tests need no key and make no network calls. Their OpenAI replies are hand-written fakes that copy the documented response *shapes*. They prove the code's behaviour, not OpenAI's.
