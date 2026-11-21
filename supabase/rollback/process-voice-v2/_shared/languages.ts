// Language registry shared by the web app and the Edge Functions (no Deno/browser APIs).
//
// Two separate capabilities per language, each with an honest status:
//   ui    — interface translation:  'reviewed' (checked by a fluent speaker) | 'draft' (written
//           but not yet reviewed by a native speaker) | 'none' (falls back to English).
//   voice — speech recognition, as measured by OUR tests (scripts/eval):
//           'verified' (meets the error-rate threshold on enough native-speaker samples) |
//           'experimental' (some tests run, results acceptable but limited) |
//           'unverified' (not tested by us yet; automatic detection may still work).
// `providerDocumented` records whether OpenAI's speech-to-text documentation explicitly names
// the language. It is NOT a quality claim. A language only becomes 'verified' from committed
// evaluation results (see docs/kinyarwanda/TEST_PLAN.md and docs/LANGUAGES.md).

export type UiStatus = 'reviewed' | 'draft' | 'none';
export type VoiceStatus = 'verified' | 'experimental' | 'unverified';
/** 'characters' = writing without spaces between words; word search needs a substring fallback. */
export type SearchMode = 'words' | 'characters';

export interface VoiceTestResult {
  date: string;          // YYYY-MM-DD
  samples: number;       // native-speaker recordings evaluated
  wer: number;           // word error rate, 0..1 (character error rate for 'characters' scripts)
  notes?: string;
}

export interface LanguageInfo {
  /** ISO 639-1 code (lower case). Also what is sent to the transcription provider as a hint. */
  code: string;
  name: string;          // English name
  nativeName: string;    // name in the language itself, shown in pickers
  direction: 'ltr' | 'rtl';
  /** BCP 47 locale for dates/numbers in the UI. */
  locale: string;
  ui: UiStatus;
  voice: VoiceStatus;
  providerDocumented: boolean;
  search: SearchMode;
  voiceTest: VoiceTestResult | null;
}

/** Minimum evidence for 'verified' voice support. */
export const VERIFIED_MIN_SAMPLES = 20;
export const VERIFIED_MAX_WER = 0.15;
export const MAX_SPEECH_LANGUAGES = 3;

const L = (
  code: string, name: string, nativeName: string, locale: string,
  extra: Partial<Pick<LanguageInfo, 'direction' | 'ui' | 'providerDocumented' | 'search'>> = {},
): LanguageInfo => ({
  code, name, nativeName, locale,
  direction: extra.direction ?? 'ltr',
  ui: extra.ui ?? 'none',
  voice: 'unverified', // nothing has been tested with real speakers yet
  providerDocumented: extra.providerDocumented ?? false,
  search: extra.search ?? 'words',
  voiceTest: null,
});

// providerDocumented: OpenAI's file-transcription guide (checked 2026-11-19) names en, es, fr
// (ISO 639-1 examples) and Chinese locale codes; other languages were not named there.
export const LANGUAGES: readonly LanguageInfo[] = [
  L('en', 'English', 'English', 'en-GB', { ui: 'reviewed', providerDocumented: true }),
  // French UI strings were written during development and still need a native speaker's review.
  L('fr', 'French', 'Français', 'fr-FR', { ui: 'draft', providerDocumented: true }),
  L('rw', 'Kinyarwanda', 'Ikinyarwanda', 'rw-RW'),
  L('es', 'Spanish', 'Español', 'es-ES', { providerDocumented: true }),
  L('pt', 'Portuguese', 'Português', 'pt-PT'),
  L('de', 'German', 'Deutsch', 'de-DE'),
  L('it', 'Italian', 'Italiano', 'it-IT'),
  L('nl', 'Dutch', 'Nederlands', 'nl-NL'),
  L('sw', 'Swahili', 'Kiswahili', 'sw-KE'),
  L('ar', 'Arabic', 'العربية', 'ar', { direction: 'rtl' }),
  L('zh', 'Chinese', '中文', 'zh-CN', { providerDocumented: true, search: 'characters' }),
  L('ja', 'Japanese', '日本語', 'ja-JP', { search: 'characters' }),
  L('ko', 'Korean', '한국어', 'ko-KR'),
  L('hi', 'Hindi', 'हिन्दी', 'hi-IN'),
  L('tr', 'Turkish', 'Türkçe', 'tr-TR'),
  L('ru', 'Russian', 'Русский', 'ru-RU'),
  L('id', 'Indonesian', 'Bahasa Indonesia', 'id-ID'),
  L('ro', 'Romanian', 'Română', 'ro-RO'),
  L('pl', 'Polish', 'Polski', 'pl-PL'),
  L('uk', 'Ukrainian', 'Українська', 'uk-UA'),
  L('am', 'Amharic', 'አማርኛ', 'am-ET'),
  L('lg', 'Luganda', 'Luganda', 'lg-UG'),
  L('yo', 'Yoruba', 'Yorùbá', 'yo-NG'),
  L('zu', 'Zulu', 'isiZulu', 'zu-ZA'),
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Same pattern as the database check on profiles (ISO 639 code, optional region/script). */
export const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

export function getLanguage(code: string | null | undefined): LanguageInfo | undefined {
  return code ? BY_CODE.get(code.toLowerCase()) : undefined;
}

export function isKnownLanguage(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code.toLowerCase());
}

/** Native name for display; falls back to the code itself for languages not in the registry. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return getLanguage(code)?.nativeName ?? code;
}

/** Languages that have an interface translation (reviewed or draft). */
export function interfaceLanguages(): LanguageInfo[] {
  return LANGUAGES.filter((l) => l.ui !== 'none');
}

/** Cleans a user's spoken-language selection: known codes only, no duplicates, at most 3. */
export function sanitizeSpeechLanguages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const code = raw.trim().toLowerCase();
    if (BY_CODE.has(code) && !out.includes(code)) out.push(code);
    if (out.length === MAX_SPEECH_LANGUAGES) break;
  }
  return out;
}

/** Normalises a model-reported language to a registry code, or 'other' / 'none'. */
export function normaliseDetectedLanguage(raw: unknown): string {
  if (typeof raw !== 'string') return 'other';
  const code = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (code === 'none' || code === 'und' || code === '') return 'none';
  return BY_CODE.has(code) ? code : 'other';
}

/** True when this language's voice status is backed by enough recorded test evidence. */
export function meetsVerifiedThreshold(t: VoiceTestResult | null): boolean {
  return !!t && t.samples >= VERIFIED_MIN_SAMPLES && t.wer <= VERIFIED_MAX_WER;
}
