// AI provider abstraction for process-voice. One active implementation (OpenAI); another
// provider can be added by implementing AiProvider and adding its prices to mvl_price_book.
import { EXTRACTION_JSON_SCHEMA } from '../_shared/extraction.ts';
import { redactSecrets } from '../_shared/secrets.ts';
import { buildTranscriptionForm, OPENAI_API, pipelineModelKey } from '../_shared/transcription.ts';

export class UpstreamError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface TranscriptionResult { data: unknown; usage: unknown }
export interface ExtractionCall {
  parsed: unknown;
  /** Set when the model returned no usable JSON (incomplete, empty, malformed). */
  parseError: UpstreamError | null;
  /** Set when the model declined to answer (safety refusal). */
  refusal: string | null;
  usage: unknown;
}

export interface AiProvider {
  /** Provider id stored in the usage ledger and used to look up prices. */
  readonly id: string;
  readonly transcribeModel: string;
  readonly textModel: string;
  /** mvl_price_book.model for a voice capture (transcription + extraction). */
  readonly voicePriceModel: string;
  /** mvl_price_book.model for a typed capture (extraction only). */
  readonly textPriceModel: string;
  transcribe(audio: Blob, extension: string, speechLanguages: string[]): Promise<TranscriptionResult>;
  extract(args: { instructions: string; input: string; maxOutputTokens: number }): Promise<ExtractionCall>;
}

export interface OpenAiConfig {
  apiKey: string;
  transcribeModel: string;
  textModel: string;
  fetch: typeof fetch;
}

export function createOpenAiProvider(cfg: OpenAiConfig): AiProvider {
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };

  async function failure(res: Response, what: string): Promise<UpstreamError> {
    // OpenAI's 401 body echoes a masked fragment of the key ("Incorrect API key provided:
    // sk-proj-****ab12"), so error text is redacted and bounded before it can reach any log.
    const body = await res.text().catch(() => '');
    return new UpstreamError(res.status, `OpenAI ${what} ${res.status}: ${redactSecrets(body)}`);
  }

  return {
    id: 'openai',
    transcribeModel: cfg.transcribeModel,
    textModel: cfg.textModel,
    voicePriceModel: pipelineModelKey(cfg.transcribeModel, cfg.textModel),
    textPriceModel: cfg.textModel,

    async transcribe(audio, extension, speechLanguages) {
      const send = (langs: string[]) => cfg.fetch(`${OPENAI_API}/audio/transcriptions`, {
        method: 'POST',
        headers: auth, // fetch sets the multipart boundary itself
        body: buildTranscriptionForm(audio, extension, cfg.transcribeModel, langs),
        signal: AbortSignal.timeout(120_000),
      });
      let res = await send(speechLanguages);
      if (res.status === 400 && speechLanguages.length > 0) {
        // A language hint the model does not accept must not block the capture: retry once
        // with automatic detection. Rejected requests are not billed.
        console.warn('process-voice: transcription rejected with language hints; retrying without', redactSecrets(await res.text().catch(() => '')));
        res = await send([]);
      }
      if (!res.ok) throw await failure(res, 'transcription');
      const data = await res.json();
      return { data, usage: (data as { usage?: unknown })?.usage };
    },

    async extract({ instructions, input, maxOutputTokens }) {
      const res = await cfg.fetch(`${OPENAI_API}/responses`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.textModel,
          instructions,
          input,
          text: { format: { type: 'json_schema', name: 'mvl_extraction', schema: EXTRACTION_JSON_SCHEMA, strict: true } },
          max_output_tokens: maxOutputTokens, // bounds the worst-case cost reserved in the database
          reasoning: { effort: 'none' },       // no paid reasoning tokens for a simple extraction
          store: false,                        // do not keep user content on the provider side
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw await failure(res, 'responses');
      // deno-lint-ignore no-explicit-any
      const data: any = await res.json();
      const usage = data?.usage;
      if (data?.status === 'incomplete') {
        return { parsed: null, refusal: null, usage, parseError: new UpstreamError(502, `OpenAI response incomplete (${data?.incomplete_details?.reason ?? 'unknown'})`) };
      }
      let text = '';
      let refusal: string | null = null;
      for (const item of Array.isArray(data?.output) ? data.output : []) {
        if (item?.type !== 'message') continue;
        for (const part of Array.isArray(item.content) ? item.content : []) {
          if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
          if (part?.type === 'refusal') refusal = String(part.refusal ?? 'refused');
        }
      }
      if (refusal) return { parsed: null, refusal, usage, parseError: null };
      if (!text) return { parsed: null, refusal: null, usage, parseError: new UpstreamError(502, 'OpenAI returned no content') };
      try {
        return { parsed: JSON.parse(text), refusal: null, usage, parseError: null };
      } catch {
        return { parsed: null, refusal: null, usage, parseError: new UpstreamError(502, 'OpenAI returned malformed JSON') };
      }
    },
  };
}
