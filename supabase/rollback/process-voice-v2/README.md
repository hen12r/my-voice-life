# Rollback snapshot: `process-voice` version 2

An exact copy of the files of the **live** `process-voice` Edge Function **version 2** on Supabase project `my-voice-life` (`nwglzabnezhmxfyuxhmg`). Fetched read-only on 2026-11-21 with the Supabase connector (`get_edge_function`).

| Field | Value |
|---|---|
| Function id | `2b7f1de7-a22b-41c2-9108-47878c869cb0` |
| Version | 2 (ACTIVE), deployed 2026-11-20 ~20:39 UTC |
| `verify_jwt` | **true** (must stay true) |
| Bundle sha256 (`ezbr_sha256`) | `5c90ea5df97a273fae22e0f9d03779c01e52edd2aa2f9888b3e0b99d78d86d5e` |
| Equivalent branch source | `claude/stripe-billing` at `d84c1b8` (only difference: `extraction.ts` writes one zero-width space literally instead of as `​`) |

It contains no secrets. They are read at runtime from Supabase Edge Function secrets.

**This folder is not built, tested or deployed by CI.** It exists only so that version 2 can be restored exactly. To roll back, see `docs/PROCESS_VOICE_DEPLOY.md` § Rollback.
