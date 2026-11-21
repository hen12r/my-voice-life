# Desktop test checklist (laptop or desktop browser, about 20 minutes)

**Who:** the owner, on their computer, signed in as the hen… account.
**Where:** https://my-voice-life-git-claude-stripe-billing-henry7.vercel.app (sign in to Vercel first if it asks).
**Browser:** latest Chrome or Edge first. Repeat steps 1, 10 and 14 in Firefox or Safari if you have time.
**How to report:** write ✅ or ❌ for each line. For any ❌, add what you saw and a screenshot. If something looks broken, also open DevTools (F12) → **Console**, and copy any red error lines. Never send passwords or keys.

## A. Layout and navigation
| # | Do this | Expected |
|---|---|---|
| 1 | Open the site full-screen, click **Sign in**, sign in with email + password | You land on the dashboard. A **left sidebar** lists Dashboard, Notes, Tasks, Schedule, Memory and Settings, plus a Capture button. No Google button on the login page (normal for now) |
| 2 | Click every sidebar item once | Each page opens; the active item is highlighted; no endless spinner |
| 3 | Make the browser window narrow (under about 1000 px wide) | The sidebar disappears and a bottom tab bar appears. Nothing is cut off; no sideways scrolling |
| 4 | Restore full width, then zoom to 200% (Ctrl/Cmd and +) | Text gets bigger and still fits; no overlapping text. Reset with Ctrl/Cmd and 0 |

## B. Your data (persistence)
| # | Do this | Expected |
|---|---|---|
| 5 | **Notes → new note**: title "Test note", any text, save | It appears in the list |
| 6 | Edit it to "Test note edited", save. Then delete it | The title changes, then the note disappears (after a confirmation if one is asked) |
| 7 | **Tasks → new task** "Test task", due today. Click its circle | The task appears (also on the dashboard), then shows as done |
| 8 | **Schedule → new reminder** "Test reminder", 1 hour from now | It shows the right time in your time zone |
| 9 | **Schedule → new event** "Test event", tomorrow 10:00–11:00 | It appears on tomorrow at 10:00 |
| 10 | Press **F5**, then close the tab and reopen the site | The task, reminder and event are still there; you are still signed in |
| 11 | **Memory → search** "Test" | Your test items are found |

## C. Keyboard and accessibility
| # | Do this | Expected |
|---|---|---|
| 12 | On the login page, use only **Tab**, **Shift+Tab** and **Enter** | You can reach every field and button in a sensible order, with a visible focus outline |
| 13 | Open any dialog (for example a new note), then press **Esc** | The dialog closes |

## D. Settings, pricing, legal
| # | Do this | Expected |
|---|---|---|
| 14 | **Settings**: switch the interface language to Français, then back to English | The texts change language and back |
| 15 | Open **Pricing**, **Privacy policy** and **Terms** (links in Settings) | Pricing shows Free and Premium and says Premium is not available yet, with no payment button. Privacy and Terms show the yellow "draft" notice |

## E. Microphone (no AI needed for these)
| # | Do this | Expected |
|---|---|---|
| 16 | Click **Capture**, then the microphone. When the browser asks, click **Allow** | Recording starts; a timer counts up |
| 17 | Speak, then stay silent for a few seconds | The microphone ring moves when you speak and calms when you are silent |
| 18 | Stop the recording | **Either** the review screen appears (the AI works), **or** you get a clear "not configured / not available" message. Note which one. Never a made-up result |
| 19 | Click the padlock or settings icon at the left of the address bar → **Microphone → Block**, reload, try to record | A clear message explaining the microphone is blocked and how to allow it again; typing a note still works. Then set the microphone back to **Allow** |

## F. Sign-out and errors
| # | Do this | Expected |
|---|---|---|
| 20 | Sign out, then sign in with a wrong password | A clear "email or password is incorrect" message |
| 21 | While signed out, type `/app/notes` at the end of the address | You are sent to the sign-in page |

**Do NOT do:** delete your account, or enter card details anywhere.
Deleting the test items at the end is optional.

**Not covered here:** real phones (iPhone Safari, Android Chrome). Those still need one pass before inviting people who will use a phone.
