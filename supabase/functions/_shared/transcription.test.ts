import { describe, expect, it } from 'vitest';
import { audioExtension, buildTranscriptionForm, DEFAULT_TEXT_MODEL, DEFAULT_TRANSCRIBE_MODEL, pipelineModelKey, transcriptText } from './transcription.ts';

describe('transcription request', () => {
  it('uses the documented default models', () => {
    expect(DEFAULT_TRANSCRIBE_MODEL).toBe('gpt-transcribe');
    expect(DEFAULT_TEXT_MODEL).toBe('gpt-6-luna');
    expect(pipelineModelKey('gpt-transcribe', 'gpt-6-luna')).toBe('gpt-transcribe+gpt-6-luna');
  });
  it('maps browser recording types to accepted extensions and rejects others', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension('audio/ogg')).toBe('ogg');
    expect(audioExtension('image/png')).toBeNull();
  });
  it('builds a multipart body with model, file, json format and up to 3 known language hints', () => {
    const form = buildTranscriptionForm(new Blob([new Uint8Array(10)], { type: 'audio/webm' }), 'webm', 'gpt-transcribe', ['rw', 'fr', 'xx', 'en', 'sw']);
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(form.getAll('languages[]')).toEqual(['rw', 'fr', 'en']);
    expect((form.get('file') as File).name).toBe('recording.webm');
  });
  it('omits language hints when none are selected (automatic detection)', () => {
    expect(buildTranscriptionForm(new Blob(['x']), 'ogg', 'gpt-transcribe', []).getAll('languages[]')).toEqual([]);
  });
  it('reads and bounds the transcript text', () => {
    expect(transcriptText({ text: '  Muraho  ' }, 100)).toBe('Muraho');
    expect(transcriptText({ text: 'abcdef' }, 3)).toBe('abc');
    expect(transcriptText(null, 10)).toBe('');
  });
});
