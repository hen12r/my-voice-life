# Work log

A record of completed and unfinished work. Newest first. "Verified" means a test or tool output shows it; anything else is labelled.

## 2026-11-18/19 — autonomous cloud session (branch `claude/autonomous-hardening`)
Run in Claude Code **cloud** (session environment `anthropic_cloud`), with the owner's computer off. Based on PR #1 head `feaa738`.

### Completed (all pushed)
| Commit | Change | Evidence |
|---|---|---|
| `743b216` | Pre-flight script rewritten as one read-only SELECT returning a JSON report; works on a brand-new project | ran on the real empty `my-voice-life` project (read-only) and on the local simulated FitPick DB |
| `4fd850b` | `process-voice` split into `handler.ts` (logic, injectable deps) + `index.ts` (wiring); 16 Deno orchestration tests; voice capture measuring 0 s is refused before reserving | 16/16 pass; ignoring refusals makes 3 tests fail (mutation check) |
| `5b4fcd1` | Review fixes: authenticate before revealing `ai_not_configured`; en/fr messages for 5 error codes + test that every backend code is translated; "Re-organise" disabled when AI blocked; admin link in Settings (mobile) | 17/17 Deno, 56/56 unit |
| `535b963` | GitHub Actions CI: typecheck, unit, build + secret-guard self-test, Deno check + tests, full DB suite on Postgres 16 | **CI run #1 succeeded on GitHub** (all 13 steps) |
| `a46e10a` | DB harness stops at the first failing migration (found in CI's DB log); guard check covers `mvl_*` tables; CI actions bumped to v5 | 130/130 DB checks |
| `8a0f1c1` | Vitest 5.1.1 (fixes 2 critical + 1 moderate advisories in dev tooling; production deps had 0) | `npm audit`: 0 vulnerabilities; 56/56 unit; build OK |

### Skipped because they need the owner's approval
- Applying migrations to the `my-voice-life` Supabase project (approval pending).
- Creating the Vercel project, deploying, enabling Gemini billing or adding a key, Stripe, merging PR #1, closing PR #3.

### Blockers (need the owner)
- No Vercel project → no preview deployment to verify.
- Migrations not applied → app can't be tested end-to-end against Supabase.
- No Gemini key → the real AI path is untested (orchestration is tested with fakes).

## 2026-11-19 — Remote setup (owner-approved)
- PR #2 merged into PR #1's branch (`d74e470`); CI green.
- **Migrations applied to Supabase `my-voice-life` (`nwglzabnezhmxfyuxhmg`)**:
  - Both files were applied unchanged, via the Supabase connector.
  - Migration history was repaired to versions `20261118000001` / `20261118000002`, so a later `supabase db push` applies nothing new.
  - Remote schema fingerprint matches a local build from the files: all 19 tables, 31 policies, columns, constraints, indexes, triggers, seed rows, and every function and grant this project created.
  - The only extra remote function is Supabase's own `rls_auto_enable`.
  - RLS is on everywhere; `ai_mode = admins_only`; budgets are $2/day and $20/month; 0 users and 0 staff.
  - The security advisor reports only intended items: deny-all tables reached through RPCs, and admin RPCs that check `mvl_is_admin()`.
- **Vercel project `my-voice-life`** was created and linked to `hen12r/my-voice-life`:
  - settings: Vite, `npm ci` / `npm run build` / `dist`, Node 22.x;
  - environment variables: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`;
  - Vercel Authentication is on.
- **Deployment incident:** a first API-triggered build was classified `production` by Vercel even though no target was sent. It was cancelled within seconds, before it was ready, so nothing was served. Previews now come from Git pushes to this branch.
- Not done yet: Edge Functions deployment, Gemini key, admin account, Supabase Auth URL configuration.

## Earlier milestones
See `docs/ROADMAP.md` (status table with evidence) and the PR #1 description.
