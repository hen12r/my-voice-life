# Phone test checklist (about 15 minutes)

**Who:** the owner, on their own phone, signed in as the hen… account.
**Where:** https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app (sign in to Vercel if it asks).
**How to report:** for each line, write ✅ or ❌. For any ❌, add what you saw and a screenshot. Never send passwords or keys.

| # | Do this | Expected |
|---|---|---|
| 1 | Open the site, tap **Sign in**, sign in with email + password | You land on the dashboard. No Google button is shown (normal for now) |
| 2 | Bottom menu: open each tab once | Every tab opens. Nothing is cut off at the sides; no endless spinner |
| 3 | **Notes → new note**: title "Test note", any text, save | It appears in the list |
| 4 | Open "Test note", change the title to "Test note edited", save | The list shows the new title |
| 5 | Delete "Test note edited" | It disappears, after a confirmation if one is asked |
| 6 | **Tasks → new task** "Test task", due today | It appears, and also on the dashboard |
| 7 | Tap the circle next to "Test task" | It shows as done (ticked or crossed out) |
| 8 | **Schedule → new reminder** "Test reminder", 1 hour from now | It appears with the right time in your time zone |
| 9 | **Schedule → new event** "Test event", tomorrow 10:00–11:00 | It appears on tomorrow at 10:00 |
| 10 | Pull down to refresh, or close and reopen the browser | The task, reminder and event are all still there; you're still signed in |
| 11 | **Memory → search** "Test" | Your test items are found |
| 12 | **Settings**: change the interface language to Français, then back to English | The texts change language and change back |
| 13 | **Settings → Pricing** | Shows Free and Premium. Says Premium is not available yet. No payment button |
| 14 | **Capture** (microphone) | The browser asks for microphone permission. Allow it, say a sentence, stop. **Either** the review screen appears (the key works), **or** you see a clear "not configured / not available" message. Note which. Never a fake result |
| 15 | While recording, speak, then stay silent | The microphone ring moves when you speak and calms when silent |
| 16 | Sign out, then try to sign in with a wrong password | A clear "email or password is incorrect" message |
| 17 | Turn the phone sideways on one page | The layout still fits |

**Do NOT do:** delete your account, or tap anything that asks for card details.
Delete the test items at the end, or leave them. Both are fine.

After step 14, tell Claude whether you got the review screen. If you did, Claude can check the real cost of that capture in the database (read-only).
