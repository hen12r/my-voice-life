# Professional product development: report (session of 21 Nov 2026)

**Scope agreed for this session:** the installable app (PWA) and the platform plan. The rest of the brief (design system and dark mode, onboarding, core-feature review and data export, multi-provider AI, billing changes) was **not started** in this session; it is planned below.
**Nothing was deployed, migrated, merged, published or charged.**

## Decisions you made (recorded, to implement next)
| Decision | Effect on the code (not yet done) |
|---|---|
| **AI model: Hybrid.** Plans include AI allowances paid by the project key; users may also connect their own key | Re-enable the included allowance for Free/Plus/Pro (Free 7 captures / 15 min, Plus 300 / 600, Pro higher) through the existing `mvl_reserve_ai_capture` budgets. Keep BYOAI as an option: own key first, else the included allowance. Rework Pricing copy (no longer "no AI credits"). Needs a migration (allowances for plus/pro, `ai_mode` change approved separately) and the CLAUDE.md rule 13 change. |
| **Monthly + yearly prices** | `STRIPE_PRICE_PLUS_YEARLY` / `STRIPE_PRICE_PRO_YEARLY`; price→plan + interval mapping; Monthly/Yearly switch on Pricing (only when a yearly price exists); tests. |

## 1. What I improved
- Sign-in keeps deep links with their query string (previously lost). Still restricted to `/app…` and `/pricing…`, so a link can't redirect to another site.
- Manifest made complete:
  - stable `id`;
  - orientation `any` (iPad, desktop);
  - maskable 192 + 512 icons;
  - real screenshots (narrow + wide);
  - shortcuts;
  - `launch_handler`.

## 2. What I implemented
- **Service worker** (`public/sw.js`):
  - caches only public same-origin static files;
  - never touches Supabase, Stripe, OpenAI, non-GET requests, `Authorization` requests or page navigations;
  - each deploy gets a new cache, and old ones are deleted.
- **Safe updates:** a new version waits and the app offers "Reload". Never automatic, never mid-recording. Hourly update checks.
- **Offline:** `offline.html` (no user data, light/dark, en/fr) and an in-app offline banner.
- **Install experience:** a Settings card with a real install button (only when the browser offers one), Safari steps on iPhone/iPad, and an "installed" state. Hidden otherwise: no dead button.
- **Headers:** `sw.js` and the manifest are served with no caching (Vercel).
- **Tests:** `npm run test:pwa` (real Chromium, production build) and unit tests for iOS detection.
- **Platform plan:** `docs/PLATFORMS.md` and an Android TWA template (`platforms/android-twa/`).

## 3. Fully functional (tested in this environment)
- Service worker registration and control; cache contents; offline page; offline banner; the update flow (offer → accept → old cache deleted); manifest icons; Chromium installability (**0 errors**); deep link through sign-in.
- All in **real Chromium** against the production build. **Supabase was mocked** (no real account involved).

## 4. Only prepared (not done)
- Android Play Store app (TWA): template and steps only. **Not built, not published.**
- iOS App Store app: decision and steps only (Capacitor, when native features justify it). **Not started.**
- Desktop wrapper: not recommended. Browser install already gives a real app window.

## 5. Remaining unfinished
| Item | Priority |
|---|---|
| **Reminders don't notify** on any platform: needs Web Push (VAPID, subscriptions table, scheduler). Biggest product gap for a reminders app. | HIGH |
| Hybrid AI allowances + yearly prices (your decisions above) | HIGH |
| Real-device testing: iPhone Safari install, Android Chrome install, desktop Edge/Safari | HIGH |
| Design system + dark mode across the app (only the offline page has dark mode) | MEDIUM |
| Onboarding (welcome, mic intro, first note, plans explained) | MEDIUM |
| Core-feature review: notes UX fixes, data export (download all my data), persistence checks with a real account | HIGH |
| AI provider registry (transcription vs text providers; OpenAI real; Gemini/Claude documented as not connected) | MEDIUM |
| Earlier still-open items: Google sign-in config; Stripe test account; migration 6 + function deploys; legal identity; VAT | see previous reports |

## 6. Test results
| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npx vitest run` | **172 passed** |
| `npm run build` | pass (service worker stamped with the build id) |
| `npm run test:pwa` (real Chromium, mocked Supabase) | **ALL PWA CHECKS PASSED**: SW controls the page; cache has only public same-origin files (no Supabase, no HTML page, no token or email); offline banner + offline page; update offered, applied on accept, old cache deleted; icons match their sizes; installability 0 errors; deep link `/app/billing?changed=1` survives sign-in; 0 console errors |
| DB / function suites | unchanged by this work (last run: all pass; 100 function tests) |
| Real phones, Safari, Firefox | **not tested** (no devices here) |

## 7. Security
- The cache can't hold private data: it never sees other origins, `Authorization` requests or navigations. Audited in a real browser for the session token and the user's email: none found.
- The session stays where Supabase keeps it (browser localStorage, per origin), never in the service-worker cache.
- `sw.js` is served `no-cache`, so a bad worker can be replaced by the next deploy.
- No new secrets or keys were added anywhere.

## 8. Credentials needed for the platform work (none in the repository)
- **Production domain** (owner): Vercel domain, Supabase Auth redirect URLs, `ALLOWED_ORIGINS`, TWA `host`.
- **Google Play Console** account (adult) and the **Android signing keystore** (kept offline). The keystore's SHA-256 fingerprint goes into `assetlinks.json`.
- **Apple Developer Program** (adult, paid) plus a Mac with Xcode: only when an iOS app is justified.
- **VAPID key pair** for Web Push (generated server-side → Edge Function secret): when push is built.
- Still pending from before: Stripe test keys, webhook secret and price ids; the OpenAI key (adult); Google OAuth client.

## 9. Adult approvals needed
1. Production domain choice and DNS.
2. Play Console account (if Android store listing is wanted).
3. Apple Developer Program (only when the iOS app is justified).
4. Migration for Web Push subscriptions (when built).
5. The previously pending approvals: migration 6, function deploys, Stripe test account, OpenAI billing.

## 10. Recommended next steps for Claude in Chrome (once connected)
1. On the preview (signed in):
   - open Settings → "Install the app";
   - install it in Chrome/Edge on a computer;
   - check the window, the shortcuts (right-click the icon) and offline behaviour (turn Wi-Fi off and reopen).
2. Check the deployed `/manifest.webmanifest` and `/sw.js` headers in DevTools → Application (Manifest and Service workers panels show any warnings).
3. With the owner present: Supabase dashboard → Auth → URL configuration, to add the production domain once chosen. The owner types any secrets; Claude never sees or copies them.
4. Later, with the adult: Play Console setup and upload of the TWA `.aab` built on the owner's machine.
