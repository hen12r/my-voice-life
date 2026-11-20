# Languages

My Voice Life keeps two separate settings:
- **interface language:** the language of the app's buttons and text;
- **spoken languages:** up to 3 languages the user speaks.

Users can speak naturally, including when they mix languages. Transcripts and notes are kept in the original language.

The registry in `supabase/functions/_shared/languages.ts` is the **single source of truth**. The app and the backend both read it, and unit tests stop it from claiming support it hasn't earned.

## Status meanings
**Interface translation (`ui`)**
- `reviewed`: checked by a fluent speaker.
- `draft`: written but not yet reviewed by a native speaker. It is shown with *"translation awaiting review"*.
- `none`: the interface falls back to English, but dates and numbers still use that language's locale.

Interface text is **never machine-generated**. A new interface language needs a fluent speaker to translate `src/lib/i18n.tsx`.

**Voice recognition (`voice`)**, measured by **our** tests, not by provider claims:
- `verified`: at least 20 native-speaker recordings, with a word error rate of at most 15% (character error rate for Chinese and Japanese). The tests enforce this.
- `experimental`: some recordings tested; usable, but the evidence is limited.
- `unverified`: not tested by us yet. Automatic detection may still work. The app warns users to check the transcript.

`providerDocumented` only records whether OpenAI's speech-to-text documentation explicitly names the language. It is not a quality claim.

## Current status (2026-11-19)
| Language | Code | Interface | Voice | Named in OpenAI docs |
|---|---|---|---|---|
| English | en | reviewed | unverified | yes |
| French | fr | draft | unverified | yes |
| Kinyarwanda | rw | none | unverified | no |
| Spanish | es | none | unverified | yes |
| Chinese | zh | none | unverified | yes (locale codes) |
| Portuguese, German, Italian, Dutch, Swahili, Arabic (right-to-left), Japanese, Korean, Hindi, Turkish, Russian, Indonesian, Romanian, Polish, Ukrainian, Amharic, Luganda, Yoruba, Zulu | pt de it nl sw ar ja ko hi tr ru id ro pl uk am lg yo zu | none | unverified | not named |

**No language is "verified" yet**, English included, because no test recordings have been run against `gpt-transcribe`. That changes only with real results.

## How spoken languages are used
- The user picks up to 3 in Settings, for example Kinyarwanda + French + English.
- They are sent to `gpt-transcribe` as `languages[]` hints. That is the documented way to improve multilingual and code-switched transcription.
- If the provider rejects a hint (`400`), the request is retried **once without hints**, and the capture still works. Rejected requests are not billed.
- With none selected, the language is detected automatically.
- The organising step detects the main language spoken and writes titles in that language. It **never translates**.

## Search across languages
- Notes, tasks, reminders and events are searchable in any language.
- Word search uses Postgres's language-neutral `simple` configuration.
- Text without spaces (Chinese, Japanese) is found by substring matching. The database tests check this for Kinyarwanda, Chinese and French. Ranking for those scripts is basic; a trigram index would improve it later.

## Not built yet (deliberately)
- **Translating notes:** it would be an extra paid AI call, so it must go through the same allowance and budget reservation. The design keeps the original and stores the translation next to it. It comes after voice is verified live.
- **Right-to-left interface:** the app already sets `dir="rtl"` for a right-to-left interface language. No Arabic interface translation exists yet, so this has not been visually tested.

## How to verify a language (moves it from unverified to experimental or verified)
1. Follow `docs/kinyarwanda/TEST_PLAN.md`. It applies to any language: native speakers record the prepared sentences, including mixed-language ones.
2. Run the recordings through production's exact request:
   ```bash
   node scripts/eval/transcribe.mjs eval-data/<lang>-sheet.csv --audio-dir eval-data/audio
   ```
   This needs `OPENAI_API_KEY` in your own shell, and is billed at $0.0045 per minute.
3. Score them:
   ```bash
   node scripts/eval/score.mjs eval-data/<lang>-sheet.csv --write
   ```
4. Record the result in the registry: `voiceTest: { date, samples, wer }` and the new status. The unit tests refuse `verified` without enough evidence.
