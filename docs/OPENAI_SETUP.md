# OpenAI setup (voice → transcript → organised items)

**Status:** implemented and tested locally against fakes, on branch `claude/openai-voice`. **Not live:**
- no OpenAI account or key is connected;
- the two new migrations are not applied;
- the `process-voice` function is not deployed.

Every step below that touches a real service needs the owner's approval. The API account, billing and key are managed by the **responsible adult**.

## What the app uses (verified on developers.openai.com, 2026-11-19)
| Stage | Model | Price | Why |
|---|---|---|---|
| Speech → text | `gpt-transcribe` | **$0.0045 per minute** of audio | OpenAI's current recommended file-transcription model. Accepts several expected languages (`languages`) for mixed-language speech. |
| Text → items | `gpt-6-luna` (Responses API) | **$0.10 / $0.50** per 1M input/output tokens | Cheapest current model with Structured Outputs. Called with `reasoning.effort: none` (no paid reasoning) and `store: false` (OpenAI does not keep the content). |

A typical 1-minute voice note costs about **$0.005**. The app's own server-side limits stay in force:
- 7 free captures per month;
- premium: 300 captures and 600 minutes per month;
- $2/day and $20/month hard budgets;
- kill switch;
- `admins_only` test mode.

The worst-case cost of each capture is reserved **before** any paid call. The audio length used for that check is read from the recording file itself, so a client cannot under-declare it.

Prices live in `mvl_price_book` (rows `openai / gpt-transcribe+gpt-6-luna` and `openai / gpt-6-luna`), not in code. If you switch models, add matching price rows first, otherwise AI fails closed (`ai_price_unknown`).

## 1. OpenAI account (responsible adult)
1. Create or sign in to an account at **platform.openai.com**. The API terms require an adult account holder.
2. **Billing:** add a small prepaid credit (for example $5–10 for testing). The API has no free tier for these models.
3. **Limits:** set a monthly budget and email alert under Billing → Limits.
   - Like Google's budgets, this may only *notify*.
   - The app's own $2/day and $20/month stops are what actually block spending.
4. Create a **project** for My Voice Life, and an API key **restricted to that project**.
5. Optional but recommended: in the project settings, allow only the models `gpt-transcribe` and `gpt-6-luna`.

Never paste the key into chat, GitHub, Vercel, a `VITE_*` variable or any file in the repository. The build refuses to start if a `VITE_*` variable looks like a key.

## 2. Supabase Edge Function secrets
In the Supabase dashboard, open project **my-voice-life** (`nwglzabnezhmxfyuxhmg`), then Edge Functions → **Secrets**, and add:

| Name | Value |
|---|---|
| `OPENAI_API_KEY` | the key from step 1 (typed directly into the dashboard) |
| `ALLOWED_ORIGINS` | the app's origin(s), comma-separated, e.g. `https://my-voice-life-git-claude-wonderful-gauss-4zwbs1-henry7.vercel.app` |
| `ALERT_WEBHOOK_URL` | optional: a webhook for budget alerts (no user data is ever sent) |

Optional overrides (normally leave unset): `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_TEXT_MODEL`.

Remove any old `GEMINI_API_KEY` secret: the code no longer reads it.

## 3. Database migrations (needs approval)
Two additive migrations:
- `20261119000001_mvl_openai_pricing.sql`
- `20261119000002_mvl_multilingual.sql`

See `docs/MIGRATION_REVIEW.md` §3–4. Apply them the same way as the first two, after a dry run.

## 4. Deploy the function (needs approval)
```bash
npx supabase@3.2.0 functions deploy process-voice --project-ref nwglzabnezhmxfyuxhmg
```
`verify_jwt = true` stays on, so only signed-in users can call it.

## 5. Least-privileged tester access for the owner's account (needs approval)
A **tester** can use AI while it is in `admins_only` mode. A tester **cannot** open the admin dashboard, change limits or budgets, or see anyone else's data: every admin function checks for the `admin` role.

This is the exact change. It adds one row, and changes nothing else:
```sql
insert into public.mvl_staff (user_id, role)
select id, 'tester' from auth.users where email = 'OWNER-EMAIL'
on conflict (user_id) do nothing;
```
To check it, run this while signed in as the owner (or with the SQL editor's "impersonate user"):
```sql
select public.mvl_my_usage() ->> 'is_staff' as is_staff,   -- true
       public.mvl_my_usage() ->> 'is_admin' as is_admin;   -- false
```
To undo it:
```sql
delete from public.mvl_staff where role = 'tester'
  and user_id = (select id from auth.users where email = 'OWNER-EMAIL');
```

## 6. First live test (after steps 1–5)
1. Open the preview and go to Speak. The microphone button should now be enabled; it was greyed out before because the account was not staff.
2. Record "Tomorrow I need to call my school, prepare my CV and practise piano."
3. Expect three task cards dated tomorrow. Edit one, reject one, save.
4. In the admin dashboard (admin only) or with SQL, check the ledger row:
   - `provider = openai`;
   - `audio_seconds` ≈ the recording length;
   - `est_cost_usd` ≈ $0.0003–0.001.
5. Then run the language test sheet (`docs/LANGUAGES.md`).

## Error codes the app can show
| Code | Meaning |
|---|---|
| `ai_not_configured` | No `OPENAI_API_KEY` secret is set. |
| `ai_test_mode` | AI is limited to staff and this account is not staff. |
| `quota_*`, `rate_limited_*`, `budget_*` | A usage control refused the request before any cost. |
| `unsupported_audio` | Not a WebM/Ogg/MP4 recording, so its length could not be checked. |
| `ai_busy` | OpenAI is rate limiting. |
| `ai_unavailable` | OpenAI error or bad key. Check the function logs; the key is never logged. |
| `ai_timeout` | No answer in time. The measured length is still booked as spend. |
