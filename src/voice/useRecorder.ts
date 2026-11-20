import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopped' | 'error';
export type RecorderError = 'denied' | 'no_device' | 'busy' | 'unsupported' | 'insecure' | 'too_short' | 'failed';

/** Maps getUserMedia errors (incl. legacy Chrome names) to what the user can do about them. */
export function micErrorFromException(e: unknown): RecorderError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no_device';
  // In use by another app (calls, other tabs) or blocked at the operating-system level.
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'NotSupportedError' || name === 'TypeError') return 'unsupported';
  return 'failed';
}

/** Fallback only; the real limit comes from the user's plan (mvl_my_usage.max_capture_seconds). */
export const DEFAULT_MAX_RECORDING_MS = 2 * 60 * 1000;
const MIN_RECORDING_MS = 700;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  // Opus in WebM (Chrome/Firefox/Edge) or MP4/AAC (Safari).
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
}

export interface Recording { blob: Blob; durationMs: number }

/**
 * Microphone recorder. Audio stays in memory; nothing is persisted on the device.
 * `stop()` resolves with the recording, `cancel()` discards it.
 *
 * Performance: the live audio level is kept in a ref and read by the visualiser's own
 * animation loop (`readLevel` / `readWaveform`), so React does not re-render on every frame.
 * `elapsedMs` updates only when the displayed second changes. All measurements come from a
 * real AnalyserNode on the microphone stream — nothing is simulated.
 */
export function useRecorder(maxMs: number = DEFAULT_MAX_RECORDING_MS) {
  const maxMsRef = useRef(maxMs);
  maxMsRef.current = maxMs;
  const [state, setState] = useState<RecorderState>('idle');
  const stateRef = useRef<RecorderState>('idle');
  const [error, setError] = useState<RecorderError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [hitLimit, setHitLimit] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sampleBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelRef = useRef(0);
  const resolveRef = useRef<((r: Recording | null) => void) | null>(null);
  const cancelledRef = useRef(false);

  const go = useCallback((s: RecorderState) => { stateRef.current = s; setState(s); }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) cancelAnimationFrame(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop()); // releases the mic (indicator off)
    streamRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    levelRef.current = 0;
  }, []);

  useEffect(() => () => { cancelledRef.current = true; recorderRef.current?.state === 'recording' && recorderRef.current.stop(); cleanup(); }, [cleanup]);

  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

  const start = useCallback(async () => {
    // One recording at a time: ignore taps while a request or recording is in progress.
    if (stateRef.current === 'requesting' || stateRef.current === 'recording') return;
    setError(null);
    setHitLimit(false);
    // Browsers hide the microphone API on non-secure pages (http other than localhost).
    if (typeof window !== 'undefined' && window.isSecureContext === false) { setError('insecure'); go('error'); return; }
    if (!supported) { setError('unsupported'); go('error'); return; }
    go('requesting');
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        // Some devices reject the processing constraints: retry with plain audio.
        if ((e as { name?: string })?.name !== 'OverconstrainedError') throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (e) {
      setError(micErrorFromException(e));
      go('error');
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    cancelledRef.current = false;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    recorderRef.current = recorder;
    recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
    recorder.onstop = () => {
      const durationMs = Date.now() - startRef.current;
      cleanup();
      const resolve = resolveRef.current;
      resolveRef.current = null;
      if (cancelledRef.current) { chunksRef.current = []; go('idle'); resolve?.(null); return; }
      if (durationMs < MIN_RECORDING_MS) { chunksRef.current = []; setError('too_short'); go('error'); resolve?.(null); return; }
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
      chunksRef.current = [];
      go('stopped');
      resolve?.({ blob, durationMs });
    };

    // Real input level from the microphone (drives the visualiser; optional).
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      sampleBufRef.current = new Uint8Array(analyser.fftSize);
    } catch {
      analyserRef.current = null; // no meter: the timer and recording still work
    }

    let shownSecond = -1;
    const tick = () => {
      const analyser = analyserRef.current;
      const buf = sampleBufRef.current;
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        // RMS of the waveform, mapped to 0..1 with a gentle curve so speech fills the range.
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        levelRef.current = Math.min(1, Math.pow(rms * 4, 0.8));
      }
      const elapsed = Date.now() - startRef.current;
      const second = Math.floor(elapsed / 1000);
      if (second !== shownSecond) { shownSecond = second; setElapsedMs(elapsed); }
      if (elapsed >= maxMsRef.current && recorder.state === 'recording') { setHitLimit(true); setElapsedMs(elapsed); recorder.stop(); return; }
      timerRef.current = requestAnimationFrame(tick);
    };

    startRef.current = Date.now();
    setElapsedMs(0);
    recorder.start(1000);
    go('recording');
    timerRef.current = requestAnimationFrame(tick);
  }, [cleanup, supported, go]);

  const stop = useCallback((): Promise<Recording | null> => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'recording') return Promise.resolve(null);
    return new Promise((resolve) => { resolveRef.current = resolve; cancelledRef.current = false; rec.stop(); });
  }, []);

  /** Resolves with the auto-stopped recording when the max length is hit. */
  const waitForAutoStop = useCallback((): Promise<Recording | null> => new Promise((resolve) => { resolveRef.current = resolve; }), []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') rec.stop(); else { cleanup(); go('idle'); }
  }, [cleanup, go]);

  const reset = useCallback(() => { go('idle'); setError(null); setElapsedMs(0); }, [go]);

  /** Latest real input level, 0..1 (0 when not recording). Cheap; call from animation frames. */
  const readLevel = useCallback(() => levelRef.current, []);

  return { state, error, elapsedMs, hitLimit, supported, start, stop, cancel, reset, waitForAutoStop, readLevel };
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
