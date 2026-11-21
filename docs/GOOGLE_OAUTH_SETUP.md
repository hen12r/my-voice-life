# Google sign-in setup

**Status (21 Nov 2026): NOT WORKING in the live project. Do not call it fixed until a real Google login succeeds.**

## Diagnosis (evidence, not guesses)
- **Exact cause:** the Google provider is **disabled** in Supabase Auth for project `nwglzabnezhmxfyuxhmg`.
- **Evidence (live `auth_logs`):** every `/authorize?provider=google` request fails with `400 validation_failed: "provider is not enabled"`. Most recent: 20 Nov 2026 20:40 UTC, coming from the preview `/app`. `auth.identities` contains only `email` identities.
- **Why users saw a raw error page:** the old button let the browser navigate straight to Supabase's `/authorize`. When the provider is disabled, Supabase answers with a bare JSON error, and the app's error message never ran.
- **Code fix (branch `claude/stripe-billing`):**
  - `src/auth/providers.ts` reads the public `GET /auth/v1/settings` endpoint (`external.google`). If Google is disabled, the button is **not shown at all**: no dead button, no raw error page.
  - When Google is enabled, the button gets the authorize URL first (`skipBrowserRedirect`), then navigates. A cancelled or refused Google login returns to `/login` with a readable message, and the error is removed from the URL.
  - Email/password sign-in is untouched.
  - **Tested** with mocked Supabase in Chromium at 390 px: provider off → no button; provider on → navigates to `/auth/v1/authorize?provider=google&redirect_to=<origin>/app`; `#error=access_denied` → message shown.
  - Unit tests: `src/auth/providers.test.ts`.
- **Not done by Claude (owner-only):** creating Google credentials, entering them in Supabase, and changing Auth URL settings. These are production settings and secrets.

Never paste the Client Secret into chat, GitHub or a `VITE_*` variable. It goes only into the Supabase dashboard.

## What you must create in Google Cloud
Go to console.cloud.google.com and use a project that you control.

1. **Google Auth Platform → Branding (OAuth consent screen)**
   - App name: `My Voice Life`, plus a support email and a developer contact email.
   - App domain: the app URL. Add the privacy policy URL once the app has one.
   - Audience: **External**. Leave it in **Testing**, and add the test users' Google accounts, until you are ready to publish.
   - Scopes: only the defaults `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. The app requests nothing else.
2. **Clients → Create client**
   - Application type: **Web application**.
   - Name: `My Voice Life (Supabase)`.
   - **Authorised JavaScript origins:**
     - `https://my-voice-life-git-claude-wonderful-gauss-4zwbs1-henry7.vercel.app`
     - later, the production domain;
     - `http://localhost:3000` (local development).
   - **Authorised redirect URIs**, exactly:
     - `https://nwglzabnezhmxfyuxhmg.supabase.co/auth/v1/callback`
   - Create it, then copy the **Client ID** and the **Client Secret**.

## What you must set in Supabase
In project **my-voice-life**:
1. **Authentication → Sign In / Providers → Google:**
   - enable it;
   - paste the Client ID and the Client Secret;
   - save.
2. **Authentication → URL Configuration.** These should already be set from the email setup:
   - Site URL: the preview URL;
   - Redirect URLs: `https://my-voice-life-git-claude-wonderful-gauss-4zwbs1-henry7.vercel.app/**`, `https://my-voice-life-*-henry7.vercel.app/**` and `http://localhost:3000/**`.
   - The app sends users back to `/app` after Google sign-in.

## Accounts and duplicates
- **Same verified email:** Supabase links identities automatically. If someone first registered with email and password, then signs in with Google using the same address, both sign-in methods open **the same account and data**. No duplicate is created.
- **Unverified email:** a Google sign-in does not take over an email/password account that was never confirmed. Supabase only links verified identities.
- **New account:** the first Google sign-in creates a new account. The existing sign-up trigger (`on_auth_user_created_zz_mvl`) creates the profile, the free plan and the default categories, exactly as for email sign-up.

## How to test once it is configured
1. Use a private browser window, open `/login` and click **Continue with Google**.
2. Choose a test user. You should land on `/app` and be signed in.
3. In Supabase → Authentication → Users, the user shows provider `google`.
4. With a user that already has an email/password account, sign in with Google using the same email. The user list should still show **one** user with two identities.
