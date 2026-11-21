# Install My Voice Life, and receive new versions safely

My Voice Life is an **installable web app (PWA)**. One version runs everywhere: installed, it opens in its own window with its own icon, like any app. There are **no separate installer files (APK, EXE, DMG, AppImage)**. See "What is not available yet" for why.

**Where it runs today:** the test (preview) version of the development branch:
https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app

It is protected by Vercel: sign in with the Vercel account that owns the project, or use a temporary share link from the Vercel dashboard (Deployment → Share). There is no public production address yet: that needs the owner's approval (domain + production deploy).

## Install
| Device | Steps |
|---|---|
| **Windows / Linux** (Chrome or Edge) | Open the address → sign in → **Settings → Install the app → Install My Voice Life**. Or click the install icon at the right of the address bar. It appears in the Start menu / app launcher. |
| **macOS** | Chrome/Edge: same as above (it goes into Applications and the Dock). Safari 17+: **File → Add to Dock**. |
| **Android** (Chrome) | Open the address → **Settings → Install the app**, or Chrome menu ⋮ → **Install app**. The icon appears on the home screen. |
| **iPhone / iPad** (Safari) | Open the address in **Safari** → **Share** button → **Add to Home Screen** → **Add**. Settings → "Install the app" shows the same steps. Other iPhone browsers can't install web apps. |

**Launch:** tap or click the "Voice Life" icon. Long-press (phone) or right-click (computer) the icon for shortcuts: **New voice capture, Notes, Tasks**. The microphone asks for permission the first time you record.

## Uninstall
- Computer: in the app window, menu → **Uninstall**.
- Android: long-press the icon → **Uninstall**.
- iPhone: long-press the icon → **Remove App**.

Your data is **not** deleted. It stays in your account (see below).

## Your data is safe across updates and reinstalls
- Notes, tasks, reminders, events and transcripts are stored **in your account on the server (Supabase)**, not on the device. Uninstalling, reinstalling, changing phone or updating the app never deletes them. Sign in again and everything is there.
- The device only keeps your sign-in session and one sound preference (browser storage), plus a cache of the app's public files. **No personal data is cached** (verified on the live preview).
- Only **Settings → Delete my account** deletes your data, after a confirmation.

## How new versions reach you
1. **Code change** → commit on the development branch `claude/stripe-billing` → **Vercel builds a new preview automatically** (that is the existing workflow). CI runs every test on each push.
2. When you next open the app, it notices the new version in the background and shows **"A new version of My Voice Life is ready. — Reload"**. Nothing changes until you tap Reload, so it never interrupts a recording. Installed apps also check every hour.
3. **Production** (a public address for everyone) = merging into `main` after review. **Only with the owner's approval.** Production updates then reach users the same way (the Reload prompt).
4. Old cached app files are deleted automatically when a new version activates.

## How database changes stay safe
- **Additive migrations only:** a new version never deletes or rewrites user data. Each migration is a reviewed SQL file in `supabase/migrations/`.
- **Every migration comes with:**
  - a **read-only pre-flight** (`supabase/preflight/`) showing what it would touch;
  - a **tested rollback** (`supabase/rollback/`) that refuses if it would lose real data.
- Applying a migration to the real project needs the **owner's explicit approval**, every time.
- **Order matters:** migration first, then the server functions that need it, then the app. Each pending step is listed in `docs/SUBSCRIPTIONS_BYOAI_REPORT.md` and `docs/STRIPE_SETUP.md`.

## What is not available yet (honest)
| Item | Status | What's missing |
|---|---|---|
| Android **APK / Play Store** | Not built | A **public production address** (domain + production deploy, needs approval), then a Bubblewrap build on a computer with Android tooling, and a Play Console account (adult). Template: `platforms/android-twa/`. The installed web app works on Android meanwhile. |
| Windows / macOS / Linux **installers** | Not built, on purpose | Not needed: the browser install gives the same windowed app. A Tauri/Electron app would add code signing and update costs for no gain today. |
| iPhone **App Store** app | Not built | Apple rejects apps that are only a wrapped website (guideline 4.2). It needs native features (e.g. reminder notifications), an Apple Developer account (adult) and a Mac. The Home Screen web app works on iPhone meanwhile. |
| **Voice capture** | Not working for normal users yet | AI is staff-only (`ai_mode = admins_only`) and the OpenAI key is unconfirmed. 0 voice captures ever recorded. |
| **Payments** | Not configured | No Stripe test account yet; the Pricing page says so honestly. |
| **Connect your own OpenAI key** | Not on the server yet | Its function isn't deployed. The card says "not available yet". |
| **Reminder notifications** | Not built | Reminders are listed but don't alert you (needs Web Push). |
| **Google sign-in** | Off | Needs the Google client set up by the owner. |
