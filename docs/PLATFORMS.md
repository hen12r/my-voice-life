# Platforms: how My Voice Life reaches Windows, macOS, Linux, Android, iPhone and iPad

**Recommendation: one codebase, the installable web app (PWA).** Add a store wrapper only where a store listing or a native capability is worth its cost. No wrapper is built yet, and **nothing is published in any store.**

| Platform | Recommended now | Store option (later) | What it needs from the owner |
|---|---|---|---|
| Windows, macOS, Linux | **Install from Chrome/Edge** (and Safari 17+ "Add to Dock" on macOS) | none needed | nothing |
| Android | **Install from Chrome** (works today) | **Trusted Web Activity** (Google Play) via Bubblewrap | Play Console account (adult), production domain, signing key |
| iPhone / iPad | **Safari → Share → Add to Home Screen** (works today) | Capacitor app, only with real native features | Apple Developer Program (adult, paid yearly), a Mac with Xcode |
| Desktop browsers / mobile browsers | the same web app | — | — |

## What the PWA already does (tested, see "Evidence")
- **Install:** correct manifest (id, icons incl. maskable, screenshots, shortcuts) and a real install button where the browser offers one. iPhone/iPad Safari gets manual steps instead. "Installed" state shown.
- **Window:** a standalone app window on every platform above.
- **Offline:** an offline page (no user data in it) and an in-app "you're offline" banner.
- **Updates:** safe. The user chooses when to reload, so an update never interrupts a recording.
- **Deep links:** app shortcuts (Capture, Notes, Tasks); links keep their query string through sign-in.
- **Privacy of the cache:** only public static files are cached. Never Supabase data, tokens, Stripe or OpenAI responses (audited in a real browser).
- **Microphone:** the existing Permissions-Policy (`microphone=(self)`) allows it in installed apps. iOS supports the microphone in Home Screen web apps.

**Evidence:** `npm run test:pwa` drives real Chromium against the production build (Supabase mocked). Chromium's own installability check reports **0 errors**. Not yet tested on real phones or in Safari/Firefox (no devices in this environment).

## Android: Trusted Web Activity (TWA) vs Capacitor
| | TWA (recommended) | Capacitor |
|---|---|---|
| What it is | A Play Store app that opens the PWA full-screen in Chrome, with no browser UI | A native Android shell running the app in a WebView, with plugins for native features |
| Code to maintain | None beyond the PWA; updates ship when the website updates | A second build pipeline; app updates go through the Play Store |
| Fits today's app | Yes: everything already runs in the browser | Overkill until a native feature is needed |
| Native features | Web features only (mic, Web Push) | Local notifications, background tasks, share target, etc. |
| Requirements | Production domain over HTTPS; `/.well-known/assetlinks.json` proving domain ownership; Play Console | Android Studio, signing, plugin maintenance |

**Decision:** TWA first. Move to Capacitor only if reminders need guaranteed native notifications that Web Push can't provide. Template: `platforms/android-twa/`.

## iPhone and iPad
- There is no TWA equivalent on iOS. **Apple's App Review guideline 4.2 ("Minimum Functionality") rejects apps that are a repackaged website.** A plain wrapper would likely be rejected.
- The PWA works now: Home Screen install, microphone, and **Web Push for Home Screen web apps on iOS/iPadOS 16.4+** (once push is built, see below).
- An App Store app is worth it only with genuine native value, for example:
  - native local notifications for reminders;
  - a share extension ("send this text to My Voice Life");
  - Siri / Shortcuts;
  - widgets.

  That means **Capacitor** (reuses this React code) plus native plugins. Requirements: an Apple Developer Program membership (paid, adult account holder), a Mac with Xcode, an App Store privacy label, and review.
- **Decision:** PWA on iOS now. Plan a Capacitor app once reminders need native notifications or a share extension is wanted.

## Desktop (Windows, macOS, Linux)
- Chrome and Edge install the PWA as a real windowed app (Start menu, Dock, launcher), with shortcuts and its own icon. Safari 17+ on macOS can "Add to Dock".
- **Tauri / Electron: not worthwhile now.** The app needs no file system, tray or OS integration that the PWA lacks. A wrapper would add code signing (Windows certificate, Apple notarisation), auto-update infrastructure and a second release process for no user benefit.
- **Revisit if:** offline-first local storage, a global hotkey for voice capture, or a menu-bar recorder becomes a requirement. Tauri would then be preferred (much smaller than Electron).

## The real cross-platform gap: reminders don't notify yet
Reminders are stored and shown, but **nothing alerts the user at the reminder time**, on any platform. This is the most important missing native-like feature. It needs:
1. **Web Push:**
   - VAPID keys (server secret);
   - a `push_subscriptions` table (owner-only RLS);
   - a subscribe flow in Settings, asked only after a user action, as iOS requires.
2. **A scheduler** that sends due reminders, for example Supabase Cron calling an Edge Function every minute.
3. Notification text that respects privacy: it shows only the reminder title.

This is a migration plus functions plus UI. Not started; it needs approval like any other migration.

## Build processes (prepared, not run)
### Android (TWA)
1. Production domain live, with the PWA served over HTTPS.
2. Install Node ≥ 18 and the Bubblewrap CLI (`npm i -g @bubblewrap/cli`); it downloads its own JDK and Android SDK on first run.
3. `bubblewrap init --manifest https://<production-domain>/manifest.webmanifest`. Or edit `platforms/android-twa/twa-manifest.json` and run `bubblewrap update`.
4. `bubblewrap build` produces a signed `.aab` (upload) and `.apk` (test). Keep the keystore safe and offline; never commit it.
5. Put the signing certificate's SHA-256 fingerprint into `/.well-known/assetlinks.json` (template: `platforms/android-twa/assetlinks.template.json`) and deploy it on the production domain. Without it, Android shows a browser bar.
6. The owner uploads to the Play Console (internal testing first). Store review is required; **no Play listing exists today.**

### iOS (Capacitor), when justified
1. `npm i @capacitor/core @capacitor/cli @capacitor/ios`, then `npx cap init "My Voice Life" <bundle-id> --web-dir dist`.
2. `npm run build && npx cap add ios && npx cap sync`, then open in Xcode on a Mac.
3. Add the native features that justify the app. Set `NSMicrophoneUsageDescription`. Configure sign-in redirect URLs (Supabase Auth allow-list) for the app scheme.
4. Archive and upload with the owner's Apple Developer account, then App Store review. **Not started.**

### Desktop
No build needed: users install from the browser. If a Tauri app is approved later, the steps go here.

## Credentials and accounts these steps need (none are in the repository)
| What | Who provides it | Where it goes |
|---|---|---|
| Production domain | Owner | Vercel project domains; Supabase Auth redirect URLs; `ALLOWED_ORIGINS` |
| Google Play Console account | Responsible adult | Play Console |
| Android signing keystore + SHA-256 fingerprint | Generated by Bubblewrap on the owner's machine | Keystore offline; fingerprint in `assetlinks.json` |
| Apple Developer Program membership | Responsible adult | developer.apple.com |
| VAPID key pair (for push, later) | Generated server-side | Supabase Edge Function secrets |
