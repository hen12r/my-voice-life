# Approval checklist (phone-friendly)

Do these in order. Each one is small. Where it says **"Reply"**, just send me that sentence in the Claude app and I'll do the rest. I never need your password or a code.

---

### ☐ 1. Fix your sign-in (2 minutes, you)
You have two accounts. Your notes are on the **first one (hen…)**.
- Sign in with that email. If you've forgotten the password, tap **Forgot password**.
- Or, to use **oli…** instead: open its confirmation email, or tap **Resend confirmation email** on the sign-in page.

**Reply:** "Keep hen…" or "Keep oli…". I won't delete or merge anything.

### ☐ 2. Allow the database update (migrations 3 and 4)
These add per-minute pricing and spoken-language settings. They only add things: nothing is deleted, and your data is untouched. They are tested by 160 automated checks.

**Reply:** "Approve migrations 3 and 4"

### ☐ 3. Give your account tester access (not admin)
A tester can use voice while it is limited to staff. A tester can't see the admin dashboard, change limits, or see anyone else's data. This is the exact change (one row; it can be undone):
```sql
insert into public.mvl_staff (user_id, role)
select id, 'tester' from auth.users where email = '<the account from step 1>'
on conflict (user_id) do nothing;
```
**Reply:** "Approve tester access for the account I chose"

### ☐ 4. Allow the voice function to be deployed
This puts `process-voice` on Supabase. Without a key it answers "AI not configured" and costs nothing.

**Reply:** "Approve deploying process-voice"

### ☐ 5. OpenAI key (the responsible adult does this)
The full guide is in `docs/OPENAI_SETUP.md`, steps 1–2:
1. Create an OpenAI account, add a small amount of credit, and set a monthly limit in OpenAI's billing page (for example $10).
2. Create a key, then paste it **only** in Supabase → Edge Functions → Secrets, with the name `OPENAI_API_KEY`.
3. Never paste it in a chat, in Vercel, or in the code.

The app's own limits still apply: $2 a day, $20 a month, and the kill switch.

**Reply:** "Key added"

### ☐ 6. First real voice test (you, on your phone)
1. Open the preview link and sign in.
2. Go to **Capture**, tap the microphone, and say one sentence with a task and a date.
3. Check the review cards, then accept them.

**Reply** with what happened. I'll read the logs and the costs.

### ☐ 7. Google sign-in (optional, later)
Follow `docs/GOOGLE_OAUTH_SETUP.md`. You enter the Client ID and Secret in Supabase yourself.

**Reply:** "Google set up"

### ☐ 8. Before inviting anyone outside the family
- A privacy policy (I can draft it, but you approve it).
- Tests on one iPhone and one Android phone.

---
**I will not, without your reply:** merge into `main`, deploy to production, apply migrations, add staff rows, enable billing, or touch Photosentry.
