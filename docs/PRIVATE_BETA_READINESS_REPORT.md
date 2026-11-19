# Private beta readiness report

**Date:** 2026-11-19 (target: private beta, Sunday 22 Nov 2026)
**Branch:** `claude/openai-voice` (draft PR #3 into `claude/wonderful-gauss-4zwbs1`). Nothing has been merged into `main` or deployed to production.
**Phone checklist:** [`APPROVAL_CHECKLIST.md`](APPROVAL_CHECKLIST.md)

## Verdict (read this first)
| Question | Answer |
|---|---|
| Can a few trusted people use the app this weekend? | **Yes, for manual features**: sign up, sign in, notes, tasks, schedule, memory search, settings. These run against the live Supabase project. |
| Can they use voice? | **No, not yet.** No OpenAI key, migrations 3–4 not applied, `process-voice` not deployed, no tester row. All four need your approval, and the key needs the responsible adult. |
| Has real AI ever run? | **No.** The whole voice pipeline is tested with fakes and real audio files, never against OpenAI. |
| Is Google sign-in working? | **No.** The button exists. Google Cloud credentials and the Supabase provider aren't configured. Pressing it today shows "provider is not enabled". |
| Is any language verified for voice? | **No**, English included. |

Test labels used below: **automated** (runs in CI), **mocked** (real browser, fake backend or fake microphone), **real** (live Supabase or a real device), **manual** (needs a person).

## 1. Features
| Area | State |
|---|---|
| Accounts | email and password; confirmation email; resend confirmation; password reset; sign-out (now also on mobile) |
| Manual capture | notes, tasks (with completion animation), reminders and events with time zones, categories |
| Memory | keyword search across all records, language-neutral (Kinyarwanda, French and Chinese tested in the DB suite) |
| Voice (code complete, not live) | record → server measures the real length → reservation → `gpt-transcribe` → `gpt-6-luna` extraction (strict JSON) → you review → only accepted items are saved |
| Languages | 24-language registry; up to 3 spoken languages as hints; interface in English (reviewed) and French (draft) |
| Cost controls | allowances, rate limits, $2/day and $20/month budgets, kill switch, `admins_only` mode, admin dashboard |
| Interface | signature microphone orb, live waveform, honest stages, animated review cards, sound cues (off by default), reduced motion |
| PWA | manifest, PNG and maskable icons, apple-touch icon |

## 2. Bugs fixed in this mission
| Bug | Fix | Test |
|---|---|---|
| Sign-in errors were generic ("Something went wrong") | Mapped 14 Supabase error codes to clear en/fr messages | unit + mocked |
| Unconfirmed account: no way forward | "Resend confirmation email" button | mocked |
| Signing up with an existing email silently "succeeded" | Detects empty `identities`, says the account exists and offers sign-in or reset | mocked |
| Expired or used email links landed on a blank or confusing page | Reads `#error_code` before routing and explains it, with a "new link" action | unit + mocked |
| Password typos invisible on phones | Show/hide toggle; email field without auto-capitalise or autocorrect | mocked |
| No sign-out on mobile | Button in Settings | mocked |
| Microphone errors all generic | Separate messages for denied, in use, unsupported, insecure page; retries on constraint errors | mocked |
| Upload showed "0%" forever when the browser reports no progress | Percentage shown only when the browser reports some | mocked |
| Completed tasks vanished with no feedback | Check animation, stays visible 0.9 s | mocked |
| The recorder could start twice on a double tap | Guarded | unit |

## 3. Authentication: status and the "Invalid login credentials" diagnosis
**Diagnosis from the live auth logs (read-only; no account was changed or deleted):**
- There are **two accounts**:
  - **"hen…@gmail.com"** was created first. It is **confirmed** and holds your **2 notes and 1 task**.
  - **"oli…@gmail.com"** was created later from the new preview. It has **never been confirmed**.
- Every failure came from the new preview: 4× `invalid_credentials`, 1× `email_not_confirmed`, and 2× Google "provider is not enabled".
- The sign-in code sends the email trimmed and the password exactly as typed. It was verified in a browser against a mock and against the live project's responses.

**Conclusion:** not a code bug. The password typed didn't match the account it was typed for, or the account wasn't confirmed. Supabase deliberately gives the same answer for a wrong password and an unknown email, so the app cannot tell which.

**What you do:**
1. Decide which account to keep. The data is on "hen…".
2. To use "oli…": open its confirmation email, or press **Resend confirmation email** on the sign-in page.
3. Forgot the password: use **Forgot password**. Never send it to anyone, me included.

I have not merged, deleted or edited either account, and I won't without your approval.

## 4. Google OAuth
**Not configured.** The code and the button are ready, and the redirect was tested in a browser. Setup steps are in [`GOOGLE_OAUTH_SETUP.md`](GOOGLE_OAUTH_SETUP.md):
1. A Google Cloud OAuth client.
2. Its Client ID and Secret entered in Supabase → Auth → Providers → Google.
3. Redirect URLs.

Until then the button fails with "provider is not enabled". **Recommendation:** hide nothing, but don't invite testers to use Google before it is set up. Supabase links a Google sign-in to an existing account automatically when the email matches and is verified.

## 5. OpenAI
| Item | State |
|---|---|
| Models and prices | `gpt-transcribe` $0.0045/min, `gpt-6-luna` $0.10/$0.50 per 1M tokens. Verified on developers.openai.com on 2026-11-19. |
| Code | complete behind `AiProvider` |
| Tests | 27 Deno orchestration tests (**automated, mocked OpenAI**, real recordings) |
| Live | **never called.** No account, credits or key, by your decision. |
| Key location when added | Supabase Edge Function secret `OPENAI_API_KEY` only. Never in Vercel, never `VITE_*`. |

## 6. Microphone
- **Mocked** (Chromium, fake microphone, mocked backend):
  - tester success;
  - permission denied;
  - microphone in use;
  - unsupported;
  - non-staff (AI locked);
  - provider busy;
  - cancel;
  - maximum length.
- **Real audio reactivity, proven:** a fake-microphone file of silence, loud, quiet, then silence produced orb levels of 0, 0.29, 0.05 and 0. The orb moves only with real sound.
- **Not tested:** real iPhone Safari or Android Chrome. **This is the biggest unknown for the beta.** iOS Safari records MP4/AAC. The server parses MP4 duration, which is tested with ffmpeg files, but not with a real iPhone file.

## 7. Languages
Labels follow [`LANGUAGES.md`](LANGUAGES.md):
- **verified:** none;
- **experimental:** none;
- **unverified:** all 24.

The app tells users to check transcripts. Moving any language up needs native-speaker recordings: about 20 per language, run with `scripts/eval/`.

## 8. Database
| Item | State |
|---|---|
| Migrations 1–2 (schema, financial controls) | **applied** to `nwglzabnezhmxfyuxhmg` (approved earlier) |
| Migrations 3–4 (`20261119000001_mvl_openai_pricing`, `20261119000002_mvl_multilingual`) | **not applied**; need approval |
| RLS | on for every table |
| Staff rows | 0 |
| `ai_mode` | `admins_only` |
| Edge Functions deployed | none |
| Local suite | 160 checks (**automated**, Postgres 16), including race tests |

## 9. Security review
| Check | Result |
|---|---|
| Secrets in the browser bundle | none. The build guard refuses secret-looking `VITE_*` variables. |
| Vercel environment variables | only the Supabase URL and the publishable key |
| RLS / cross-user access | DB tests prove no leakage |
| AI spend writes | only through SECURITY DEFINER accounting RPCs (service role) |
| Audio length | measured on the server from the file. The client's claim can only lengthen it. |
| Audio storage | none (in memory only) |
| Security headers / CSP | set in `vercel.json`; 0 violations in the browser |
| Dependencies | `npm audit`: 0 vulnerabilities at the last check |
| Anti-enumeration | sign-in keeps Supabase's identical error messages |
| Open items | Supabase leaked-password protection and CAPTCHA are off (dashboard settings, your choice); the privacy policy is not written; the admin webhook is untested live |

## 10. Financial controls (unchanged, all enforced in the database)
- **Captures:** Free 7 a month; Premium 300 a month **and** 600 minutes.
- **Budgets:** $2 a day and $20 a month, with worst-case holds.
- **Rate limits:** per hour and per day.
- **Kill switch:** on hand.
- **Test mode:** `admins_only` is the default.
- **Prices:** live in tables.
- **Failing closed:** a model without a price row fails closed.
- **Labelling:** projected figures are labelled as such.

Every one of these is covered by automated DB tests. None has been exercised with real money.

## 11. Tests
| Suite | Count | Label |
|---|---|---|
| Unit (Vitest) | 105 | automated |
| Deno orchestration (`process-voice`) | 27 | automated, mocked OpenAI and Supabase |
| Database (RLS, financial, multilingual, race) | 160 | automated, local Postgres |
| Typecheck, build, secret-guard self-test | all pass | automated |
| Browser: auth (8 scenarios), voice flow (6), all pages at 360 px and desktop, reduced motion | pass, 0 console errors | mocked |
| Live sign-up and sign-in on previews | happened (auth logs) | real |
| Real phones, real OpenAI, native speakers, Google | **not done** | manual |

CI runs the automated suites on every push.

## 12. Deployment
| Item | State |
|---|---|
| Previews (Vercel Authentication on) | `my-voice-life-git-claude-openai-voice-henry7.vercel.app` (this work) and `my-voice-life-git-claude-wonderful-gauss-4zwbs1-henry7.vercel.app` |
| Production | **not deployed**; `main` untouched |
| Edge Functions | not deployed |
| Supabase Auth URLs | must include the preview URL you test from, or links in emails will go to the wrong place |

## 13. Blockers
1. **Voice:** needs an OpenAI key (adult), migrations 3–4, the deployment of `process-voice`, and the tester row. All four need approval.
2. **Google:** needs credentials.
3. **Real-phone test:** needs a person with an iPhone and an Android phone.
4. **Your sign-in:** you need to choose an account and confirm it (section 3).
5. **Privacy policy:** needed before inviting anyone outside your family.

## 14. What you need to do
See [`APPROVAL_CHECKLIST.md`](APPROVAL_CHECKLIST.md). It is written to be done from a phone, one tick at a time.

---

## Appendix A: Signature microphone and motion system
**Components**
- `src/components/VoiceOrb.tsx`:
  - `VoiceOrb` has 6 modes: idle, disabled, requesting, recording, uploading and thinking.
  - `LiveWaveform` shows 32 bars of real level history.
- `src/voice/useRecorder.ts`:
  - MediaRecorder plus an `AnalyserNode`;
  - the RMS level is kept in a ref (`readLevel()`);
  - the timer ticks once per second.
- `src/index.css`:
  - motion tokens (`--ease-out`), `animate-card-in`, `animate-pop`, `.press`;
  - orb styles driven by `--lvl`;
  - a full `prefers-reduced-motion` block.
- `src/lib/sound.ts`: optional cues (Web Audio tones, no files). Off by default, with a toggle in Settings.
- `src/pages/Capture.tsx`:
  - stages;
  - review cards: type icon, chips, 70 ms stagger, edit panel that opens automatically when an item is blocked (for example a missing date), reject with Undo.

**Audio-level detection.** The time-domain RMS from the microphone's `AnalyserNode` is smoothed in the orb's own animation loop: fast attack, slow release. The loop writes a CSS variable directly, so React does not re-render each frame. It runs **only while recording**. In every other mode the level is fixed at 0, and only the slow idle "breathing" or the processing shimmer plays. Neither of those suggests sound.

**Honest stages.**
- Stage 1: "Uploading N%", using the real XHR upload progress.
- Stage 2: "Understanding your thoughts…", shown until the server responds.

The server does transcription and extraction in **one request**, so the app cannot honestly show separate "transcribing" and "organising" steps. It doesn't. Splitting them would need streaming from the function.

**Performance.**
- Animations use only `transform` and `opacity`, on the compositor.
- One rAF loop each for the orb and the waveform.
- No per-frame React state.
- The AudioContext and microphone tracks are released on stop or cancel.
- No new dependencies.

**Accessibility.**
- The orb is a real `<button>` with `aria-label` and `aria-pressed`.
- Stop and cancel keep full aria-labels ("Stop and process").
- Visible focus rings.
- Reduced motion removes breathing, rings, stagger and shimmer.

**Screenshots** (taken with a fake microphone, mocked backend, phone size): idle, recording, thinking, review, review edit, saved, plus desktop and tablet idle. They are not committed: they show mocked data and are only evidence for the review.

**Limitations.**
- Not tested on real phones.
- iOS may stop the AudioContext when the screen locks.
- Sound cues depend on the device being unmuted.
- The orb design has not been reviewed by real users.
