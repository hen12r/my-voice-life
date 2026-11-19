#!/usr/bin/env node
// Runs recordings listed in a test sheet through OpenAI transcription using EXACTLY the
// production request (supabase/functions/_shared/transcription.ts: same model, format and
// language hints) and writes the result into actual_transcription / provider_model.
//
// Requirements: Node 22.18+ (imports the shared .ts file directly).
// The API key is read from the OPENAI_API_KEY environment variable of YOUR shell only.
// Never put it in a file inside this repository and never paste it into chat or GitHub.
// Each clip is billed by OpenAI (gpt-transcribe: $0.0045 per minute on 2026-11-19).
//
// Usage:
//   node scripts/eval/transcribe.mjs eval-data/test-sheet.csv --audio-dir eval-data/audio --dry-run
//   node scripts/eval/transcribe.mjs eval-data/test-sheet.csv --audio-dir eval-data/audio [--languages rw,fr]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseCsv, toCsv } from './csv.mjs';
import { buildTranscriptionForm, DEFAULT_TRANSCRIBE_MODEL, OPENAI_API, transcriptText } from '../../supabase/functions/_shared/transcription.ts';
import { isKnownLanguage } from '../../supabase/functions/_shared/languages.ts';

const args = process.argv.slice(2);
const file = args[0];
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const audioDir = opt('--audio-dir', 'eval-data/audio');
const model = opt('--model', process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL);
const fixedLanguages = opt('--languages', '');
const dryRun = args.includes('--dry-run');
const overwrite = args.includes('--overwrite');
if (!file) { console.error('Usage: node scripts/eval/transcribe.mjs <sheet.csv> [--audio-dir dir] [--model m] [--dry-run] [--overwrite]'); process.exit(2); }

const EXT = { '.webm': 'webm', '.ogg': 'ogg', '.m4a': 'm4a', '.mp4': 'mp4', '.mp3': 'mp3', '.wav': 'wav', '.flac': 'flac' };
// Language hints, as production sends them: --languages overrides; otherwise the row's
// spoken_language when it is a single known code; mixed / code-switched rows auto-detect.
const hintsFor = (row) => fixedLanguages ? fixedLanguages.split(',') : (isKnownLanguage(row.spoken_language) ? [row.spoken_language] : []);

const text = readFileSync(file, 'utf8');
const header = text.replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
const rows = parseCsv(text);
const todo = rows.filter((r) => r.audio_file && (overwrite || !r.actual_transcription));
console.log(`${todo.length} recording(s) to transcribe with ${model}${dryRun ? ' (dry run — nothing is sent)' : ''}`);

const key = process.env.OPENAI_API_KEY;
if (!dryRun && !key) { console.error('OPENAI_API_KEY is not set in this shell. See docs/kinyarwanda/TEST_PLAN.md.'); process.exit(2); }

let done = 0, failed = 0;
for (const r of todo) {
  const path = join(audioDir, r.audio_file);
  const ext = EXT[extname(path).toLowerCase()];
  if (!existsSync(path)) { console.log(`  ✘ ${r.recording_id}: file not found ${path}`); failed++; continue; }
  if (!ext) { console.log(`  ✘ ${r.recording_id}: unsupported type ${extname(path)}`); failed++; continue; }
  const hints = hintsFor(r);
  if (dryRun) { console.log(`  · ${r.recording_id}: ${path} (${ext}, languages=${hints.join(',') || 'auto'})`); continue; }
  try {
    const form = buildTranscriptionForm(new Blob([readFileSync(path)]), ext, model, hints);
    const res = await fetch(`${OPENAI_API}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    r.actual_transcription = transcriptText(data, 10_000);
    r.detected_language = hints.length === 1 ? hints[0] : '';
    r.provider_model = `openai:${model}`;
    console.log(`  ✔ ${r.recording_id} ${r.actual_transcription.slice(0, 70)}`);
    done++;
    writeFileSync(file, toCsv(header, rows)); // save progress after each clip
  } catch (e) {
    console.log(`  ✘ ${r.recording_id}: ${e.message}`);
    failed++;
  }
}
console.log(`Done: ${done} transcribed, ${failed} failed.${done ? ' Next: node scripts/eval/score.mjs ' + file + ' --write' : ''}`);
