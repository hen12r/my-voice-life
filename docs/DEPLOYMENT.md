# Deploying My Voice Life

This repository, **`hen12r/my-voice-life`**, contains only My Voice Life.

## Where things live
| Thing | State |
|---|---|
| GitHub `hen12r/my-voice-life` (this repo) | My Voice Life only. `main` starts at the original "Initial commit" (README only). The app arrives on `main` only when the owner merges the migration PR |
| Origin of this code | migrated with full history from `hen12r/-hen12r` (branch `claude/wonderful-gauss-4zwbs1`, PR #3). Commit IDs are identical. The two oldest commits are the shared starting point with FitPick |
| GitHub `hen12r/-hen12r` | **not ours to change**: hosts FitPick (`main`) and **Photosentry** (`claude/amazing-tesla-jorf1p`, `web/`). Never push My Voice Life work there |
| Vercel `photosentry` | Photosentry's project, linked to `hen12r/-hen12r`. **Never modify it** |
| Supabase `photosentry` (`zgvftpdnqszkyyyognrv`) | Photosentry's database. **Never use it for My Voice Life** |
| Supabase `hen12r's Project` (`ognlcllsttlyariioyjx`) | paused; holds the old FitPick schema |
| Vercel project for My Voice Life | to be created in Step 1 |

> Why a separate repo: Vercel builds every branch of a connected repository, and its Ignored Build Step runs *inside* the project's Root Directory. Photosentry's Root Directory (`web`) doesn't exist on My Voice Life branches, so no ignore rule could stop those failing builds without changing Photosentry's production settings. One product per repository removes the problem entirely.

## Step 1: create the Vercel project (manual)
1. Go to **vercel.com/new** (team **henry7**) → **Import Git Repository** → **`hen12r/my-voice-life`**.
2. **Project Name:** `my-voice-life`
3. **Framework Preset:** Vite
4. **Root Directory:** leave as `./` (repository root).
5. **Build & Output settings:** leave on default. `vercel.json` pins them: install `npm ci`, build `npm run build`, output `dist`, Node 22.x (from `package.json` `engines`).
6. **Environment Variables:** add exactly two, for **Production and Preview** (and Development if you use `vercel dev`):
   | Name | Value (from **your My Voice Life** Supabase project → Project Settings → API) |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | the **Publishable** key (starts with `sb_publishable_`) |

   - **Don't copy them from the `photosentry` Vercel project.** Those point to Photosentry's database.
   - **Never** add `VITE_GEMINI_API_KEY`, a secret key (`sb_secret_…`) or a `service_role` key. The build **refuses to run** if it finds one (`scripts/env-guard.mjs`).
7. Click **Deploy**. The first deployment builds `main`, which still holds only the initial README, so **it is expected to fail or be empty**. That's harmless and doesn't reach users.
8. **Settings → Git → Production Branch:** keep `main`. Production gets My Voice Life only after the owner merges the migration PR. Until then, test with that PR's **Preview** deployment (Vercel comments its URL on the PR).

Note: preview deployments in the `henry7` team are behind Vercel Authentication, so testers must be logged in to Vercel, or you disable preview protection for this project.

## Step 2: Supabase project (manual; decision needed)
**Option 1 (recommended): create a fresh project `my-voice-life`.**
- Clean schema, no FitPick leftovers, and no question about reusing FitPick users' accounts and emails for a different product.
- Free plan: two active projects allowed (`photosentry` + `my-voice-life`). The old FitPick project stays paused.
- Steps: Dashboard → New project → name `my-voice-life` → region closest to your users → generate and **save the database password in your password manager**.

**Option 2: restore `hen12r's Project` (`ognlcllsttlyariioyjx`).**
- Choose this if FitPick has real users or data you must keep.
- Dashboard → project → **Restore project**. If the dashboard says restore is no longer available (free projects can only be restored for a limited time after pausing), use option 1.
- After restoring: take the backup described in `docs/MIGRATION_REVIEW.md` **before** anything else.

**Then, either way:**
1. Run `supabase/preflight/inspect_existing_schema.sql` in **SQL Editor** (read-only) and send me the output. On a fresh project it will show an empty schema.
2. **Authentication → URL Configuration:**
   - Site URL: `https://my-voice-life.vercel.app` (or your domain)
   - Redirect URLs: `https://my-voice-life.vercel.app/**`, `https://my-voice-life-*-henry7.vercel.app/**` (previews), `http://localhost:3000/**`
3. **Authentication → Providers → Email:** keep "Confirm email" on. Before real users arrive, configure your own SMTP; the built-in sender is heavily rate-limited.
4. Tell me which project you chose. I'll confirm its status and URL, and **wait for your explicit approval** before applying the migration (`docs/MIGRATION_REVIEW.md`).

## Step 3: Gemini key as a server-side secret (manual)
1. Create a key in **Google AI Studio** (aistudio.google.com → Get API key). In Google Cloud Console → Credentials, restrict it to the **Generative Language API**.
2. Check the data-use terms: as far as I know, the **unpaid** Gemini tier allows Google to use submitted content to improve its products, and the paid tier doesn't. Users' voice notes are personal data, so use a billed key before real users. Enabling billing costs money, so it's your decision.
3. Store it **only** as a Supabase Function Secret. The simplest way, with no key in your terminal history: **Dashboard → Edge Functions → Secrets → Add new secret**:
   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | your key |
   | `ALLOWED_ORIGINS` | `http://localhost:3000,https://my-voice-life.vercel.app,https://my-voice-life-*-henry7.vercel.app` |
   | `GEMINI_MODEL` (optional) | default `gemini-2.5-flash`. Check it's still offered in AI Studio |
   | `ALERT_WEBHOOK_URL` (optional) | an incoming-webhook URL (Slack, Discord, …) for budget alerts; messages contain no user data |

   Never paste the key into chat, GitHub, `.env.local`, Vercel, or any `VITE_` variable. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically; don't set them.
4. Deploy the functions, either yourself:
   ```bash
   npx supabase functions deploy process-voice --project-ref <project-ref>
   ```
   ```bash
   npx supabase functions deploy delete-account --project-ref <project-ref>
   ```
   or tell me "deploy the functions" and I'll do it with the Supabase tools.

## Step 3b: make yourself admin (after your first sign-up)
In Supabase → SQL Editor, replace the email with yours:
```sql
insert into public.mvl_staff (user_id, role)
select id, 'admin' from auth.users where email = 'YOUR-EMAIL' on conflict (user_id) do update set role = 'admin';
```
Testers who may use AI during private testing get `role = 'tester'`. AI starts in **staff-only** mode, and the default budgets are $2/day and $20/month; change them in **Admin → AI controls**. Google-side caps and alerts: `docs/GOOGLE_CLOUD_SAFETY.md`.

## Step 4: final verification (together)
When Steps 1–3 are done, I run and report each item with its evidence:
| # | Check | How |
|---|---|---|
| 1 | Supabase connection and status | Supabase tools: project `ACTIVE_HEALTHY`, tables present, **security advisor clean** |
| 2 | Environment variables | `npm run check:env -- --origin https://my-voice-life.vercel.app` (masked output; verifies format, auth health, anonymous access blocked, function deployed, CORS, unauthenticated calls rejected) |
| 3 | Gemini backend | function logs, plus a real capture in the app; an `ai_not_configured` error means the secret is missing |
| 4 | Build | `npm run build` |
| 5 | Tests | `npm test`, `npm run typecheck`, `npm run test:db`, `deno check` |
| 6 | Branch | `git status` / PR head SHA equals the deployed SHA |
| 7 | Fresh deployment | only with your approval: a push to the PR branch (preview) or a redeploy |
| 8 | Deployment logs | Vercel build logs for that deployment |
| 9 | Live app | the manual test plan in `docs/ROADMAP.md`: sign-up, voice capture, review, save, isolation between two accounts, delete account |

Nothing gets reported as working without the output that shows it.
