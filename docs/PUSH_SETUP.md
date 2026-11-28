# Reminder notifications (Web Push): setup and approval

**Status (28 Nov 2026): built and tested offline, NOT live.**
- Nothing below has been applied, deployed or enabled.
- In the app, Settings → "Reminder notifications" says *not available yet* and offers no button.
- Your reminders are still listed in Schedule; they just don't alert you yet.

## How it works
```
Every minute: pg_cron ──▶ pg_net POST /functions/v1/send-reminders  (header x-mvl-cron = CRON_SECRET)
send-reminders ──▶ mvl_push_claim_due()          each due reminder is claimed ONCE (due in the last hour)
               ──▶ encrypt {title, time} per device (RFC 8291) + sign (VAPID, RFC 8292)
               ──▶ POST to the browser maker's push service (Google, Apple, Mozilla, Microsoft only)
Device: service worker shows "Call the school — 09:00"; tapping it opens Schedule.
```

## Privacy and security
- **The title stays private:** it is encrypted for the user's own browser. The push service only carries ciphertext.
- **Devices are registered by the app** through a validated database function, and users see only their own devices.
  - Max 10 devices per account.
  - A device that no longer exists (404/410) is deleted automatically.
- **SSRF guard:** endpoints are limited to the four browser push services, in the database and again in code.
- **The sender:**
  - refuses any call without the right `CRON_SECRET`, compared in constant time;
  - refuses before touching any reminder if the keys are missing;
  - logs counts only: no title, address or user id.
- **Recurring reminders are not moved by the server.** You still complete them with "Complete → next" in Schedule.
- **Deleting an account deletes its devices.**

## Tests (all automated, all passing)
- **Encryption:** reproduces the official RFC 8291 test message byte for byte. The VAPID signature verifies with the public key.
- **Database:** device rules, isolation between users, "claimed once" even with two senders at the same time (40 reminders), a 1-hour window, cascade on account deletion, rollback round trip.
- **Functions:**
  - the secret check;
  - no claim without keys;
  - one message per device;
  - gone devices removed;
  - no title in the logs;
  - a forbidden address never called.
- **Real Chromium:**
  - the card's states ("not available yet", iPhone "install first");
  - a push delivered to the real service worker shows the title and the time in the reminder's time zone; a malformed one shows a safe default.
- **Not tested here: a real subscription.** The sandbox cannot reach Google's push service; the browser answered "Registration failed" and the app showed a clear error, never a fake "On". This is tested only on a real device after deployment (step 8).

## Steps for the responsible adult (each one separately approved)
1. **Pre-flight (read-only).** Run `supabase/preflight/preflight_20261128_migration_7.sql` in the SQL editor and keep the result.
2. **Approve and apply migration 7:** `supabase/migrations/20261128000001_mvl_push.sql`. Rollback: `supabase/rollback/rollback_20261128_migration_7_push.sql` (tested).
3. **Enable the extensions:** `pg_cron` and `pg_net` (Dashboard → Database → Extensions). This is a project setting shared by every environment.
4. **Create the keys on your own computer.** Never in a chat.
   - VAPID pair:
     ```
     npx web-push generate-vapid-keys
     ```
   - Cron secret (48 random characters):
     ```
     openssl rand -base64 36
     ```
5. **Supabase → Edge Functions → Secrets:**

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | the "Public Key" line |
   | `VAPID_PRIVATE_KEY` | the "Private Key" line |
   | `VAPID_SUBJECT` | a contact you choose: `mailto:you@yourdomain` or the app's https address |
   | `CRON_SECRET` | the random secret |

   Also add the **same** cron secret in Dashboard → Project Settings → **Vault**, named `mvl_cron_secret`.
6. **Approve and deploy** the functions `push` (verify JWT on) and `send-reminders` (verify JWT off: it is protected by the cron secret).
7. **Schedule it:** run `supabase/ops/schedule_send_reminders.sql` once in the SQL editor. Stop it any time:
   ```sql
   select cron.unschedule('mvl-send-reminders');
   ```
8. **Real test:**
   1. On a computer (Chrome or Edge): Settings → Turn on notifications → Send a test.
   2. Create a reminder 2 minutes ahead and wait for it.
   3. On an iPhone: install the app first (Share → Add to Home Screen, iOS 16.4+), open it from the home screen, then repeat.

**Changing the keys later** invalidates every device: users simply turn notifications on again.
