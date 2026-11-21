// Transcription request shared by the process-voice Edge Function and the offline evaluation
// tool (scripts/eval/transcribe.mjs), so evaluation measures exactly what production sends.
// Uses only Web-standard globals (FormData, Blob) available in Deno, browsers and Node 22.
import { sanitizeSpeechLanguages } from './languages.ts';

export const OPENAI_API = 'https://api.openai.com/v1';
/** Defaults verified on developers.openai.com (2026-11-19). Prices live in mvl_price_book. */
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-transcribe';
export const DEFAULT_TEXT_MODEL = 'gpt-6-luna';

/** Price-book key for the two-stage pipeline (one row covers both models' rates). */
export function pipelineModelKey(transcribeModel: string, textModel: string): string {
  return `${transcribeModel}+${textModel}`;
}

/** Audio types accepted by the transcription endpoint (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm). */
export const ACCEPTED_AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/opus': 'ogg',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'video/mp4': 'mp4', 'audio/aac': 'm4a',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
};

/** File extension for a MIME type, or null if the provider does not accept it. */
export function audioExtension(mime: string): string | null {
  return ACCEPTED_AUDIO_TYPES[mime.split(';')[0].trim().toLowerCase()] ?? null;
}

/**
 * Multipart body for POST /v1/audio/transcriptions.
 * `languages` are the user's expected spoken languages (up to 3, ISO 639-1); they improve
 * accuracy for multilingual and code-switched speech. Omitted when empty (auto-detect).
 */
export function buildTranscriptionForm(audio: Blob, extension: string, model: string, speechLanguages: string[]): FormData {
  const form = new FormData();
  form.append('model', model);
  form.append('file', audio, `recording.${extension}`);
  form.append('response_format', 'json');
  for (const code of sanitizeSpeechLanguages(speechLanguages)) form.append('languages[]', code);
  return form;
}

/** Text of a transcription response (`{ text, usage }`), trimmed and bounded. */
export function transcriptText(data: unknown, maxChars: number): string {
  const t = (data && typeof data === 'object' ? (data as { text?: unknown }).text : null);
  return typeof t === 'string' ? t.trim().slice(0, maxChars) : '';
}
