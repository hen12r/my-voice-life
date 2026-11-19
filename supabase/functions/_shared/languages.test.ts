import { describe, expect, it } from 'vitest';
import {
  getLanguage, interfaceLanguages, LANGUAGE_CODE_RE, LANGUAGES, languageLabel, MAX_SPEECH_LANGUAGES,
  meetsVerifiedThreshold, normaliseDetectedLanguage, sanitizeSpeechLanguages,
} from './languages.ts';

const REQUESTED = ['en', 'fr', 'rw', 'es', 'pt', 'de', 'it', 'nl', 'sw', 'ar', 'zh', 'ja', 'ko', 'hi', 'tr', 'ru', 'id', 'ro', 'pl', 'uk', 'am', 'lg', 'yo', 'zu'];

describe('language registry', () => {
  it('contains every requested language exactly once, with valid codes', () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of REQUESTED) expect(codes).toContain(c);
    for (const c of codes) expect(c).toMatch(LANGUAGE_CODE_RE);
  });
  it('makes no unbacked quality claims: verified/experimental voice support requires recorded tests', () => {
    for (const l of LANGUAGES) {
      if (l.voice === 'verified') expect(meetsVerifiedThreshold(l.voiceTest), `${l.code} verified without evidence`).toBe(true);
      if (l.voice === 'experimental') expect(l.voiceTest, `${l.code} experimental without any test`).not.toBeNull();
    }
  });
  it('nothing is marked verified yet (no native-speaker test recordings exist)', () => {
    expect(LANGUAGES.filter((l) => l.voice !== 'unverified')).toEqual([]);
  });
  it('Kinyarwanda has no machine-generated interface strings', () => {
    expect(getLanguage('rw')!.ui).toBe('none');
  });
  it('offers only translated interface languages, and marks right-to-left scripts', () => {
    expect(interfaceLanguages().map((l) => l.code)).toEqual(['en', 'fr']);
    expect(getLanguage('ar')!.direction).toBe('rtl');
    expect(getLanguage('zh')!.search).toBe('characters');
  });
});

describe('helpers', () => {
  it('cleans spoken-language selections: known, unique, at most 3', () => {
    expect(sanitizeSpeechLanguages(['RW', 'fr', 'fr', 'xx', 'en', 'sw'])).toEqual(['rw', 'fr', 'en']);
    expect(sanitizeSpeechLanguages('fr')).toEqual([]);
    expect(MAX_SPEECH_LANGUAGES).toBe(3);
  });
  it('normalises model-reported languages', () => {
    expect(normaliseDetectedLanguage('fr-FR')).toBe('fr');
    expect(normaliseDetectedLanguage('und')).toBe('none');
    expect(normaliseDetectedLanguage('xh')).toBe('other');
    expect(normaliseDetectedLanguage(42)).toBe('other');
  });
  it('labels languages by their own name', () => {
    expect(languageLabel('rw')).toBe('Ikinyarwanda');
    expect(languageLabel('xx')).toBe('xx');
    expect(languageLabel(null)).toBe('—');
  });
  it('requires enough samples and a low error rate for "verified"', () => {
    expect(meetsVerifiedThreshold({ date: '2026-12-01', samples: 20, wer: 0.12 })).toBe(true);
    expect(meetsVerifiedThreshold({ date: '2026-12-01', samples: 5, wer: 0.05 })).toBe(false);
    expect(meetsVerifiedThreshold({ date: '2026-12-01', samples: 50, wer: 0.3 })).toBe(false);
    expect(meetsVerifiedThreshold(null)).toBe(false);
  });
});
