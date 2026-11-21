# Bring Your Own AI: key security

Users connect **their own OpenAI API key**. That key can spend money on the user's OpenAI account, so it is treated like a payment credential.

**Status:** built and tested offline, **not deployed** (needs migration 6 plus the `ai-connections` and `process-voice` deploys). `byoai_mode` defaults to **`admins_only`**.

## Lifecycle
1. **Entry.** Settings → "Your AI provider".
   - The key is typed into a password field, with autocomplete and spellcheck off.
   - It is sent once over TLS to the `ai-connections` Edge Function, which needs a signed-in user (JWT verified).
   - The browser clears the field as soon as the request ends.
2. **Validation.** The function cleans pasting mistakes (`normaliseApiKey`) and checks the key's format. It then calls `GET https://api.openai.com/v1/models` with the key; this call is free. Both required models must be available. Nothing is stored if any check fails.
3. **Storage.**
   - `mvl_byoai_set_key()` (SECURITY DEFINER, executable by the **service role only**) writes the key with `vault.create_secret` into **Supabase Vault**, encrypted at rest.
   - `mvl_ai_connections` holds only the Vault secret id, a 4-character hint, the status and dates.
   - Users can read their own row, but not the secret-id column (column grants) and not the `vault` schema.
4. **Use.**
   - For each voice request, `process-voice` (service role) calls `mvl_byoai_get_key()` and builds a provider for that request only.
   - The key goes in the `Authorization` header to `api.openai.com` only. It is never returned to the browser.
5. **Rejection.** If OpenAI answers 401, the connection is marked `invalid`, is never used again, and the user is asked to reconnect.
6. **Removal.**
   - Disconnecting, or deleting the account (cascade), deletes the row.
   - A trigger then deletes the Vault secret. Tested: no orphaned secret remains.

## What is never done (enforced by tests)
- The key is never returned by any function. Responses carry only `{connected, hint}`.
- The key is never logged:
  - every OpenAI error text passes through `redactSecrets()`, which also removes masked fragments like `sk-proj-****ab12`;
  - `ai-connections` never logs request bodies or error details;
  - tests capture the logs and assert the key and its fragments are absent.
- The key is never sent anywhere except `api.openai.com`. Tests check every outgoing request, including the alert webhook.
- No client-reachable function can read a key. `has_function_privilege` tests cover `authenticated` and `anon`.
- One user can never see another user's connection or usage rows (RLS tests).

## Abuse limits
- **Key-testing oracle:** `ai-connections` allows at most 5 connect attempts per user per 10 minutes, and a signed-in account is required. This is an in-memory limit per function instance: a speed bump, not a guarantee.
- **Our compute:** BYOAI captures are rate-limited per plan in the database (`mvl_reserve_byoai_capture`: per hour, per day, max length), with per-user locks (race-tested). The global kill switch (`ai_mode = off`) stops BYOAI too.
- BYOAI usage is recorded in `mvl_byoai_usage`, separate from the platform AI budget tables.

## Residual risks (honest)
- **Anyone with the service-role key or database-owner access can decrypt Vault secrets.** Protect the Supabase dashboard and the service-role key as you would the keys themselves.
- **The key passes through our Edge Function memory** during validation and each request. A compromised function deployment could exfiltrate keys.
- **Supabase API logs** record request metadata, not bodies. RPC arguments go through PostgREST as parameters, so they are not stored as statement text. This was not independently audited here.
- **Users should set a spending limit on their OpenAI account.** The app tells them to.

## Owner decisions still open
- When to switch `byoai_mode` from `admins_only` to `everyone` (after a privacy review and a real end-to-end test).
- The privacy policy must state that audio and transcripts are processed by OpenAI under the user's own account (the draft does).
