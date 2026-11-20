// Subtle interface sounds, synthesised with the Web Audio API (no audio files, nothing
// downloaded). OFF by default; the user turns them on in Settings. Cues are only played in
// response to a user action or to a request the user started — never on page load.

export type Cue = 'start' | 'stop' | 'ready' | 'saved' | 'error';

const KEY = 'mvl_sound_cues';

export function soundEnabled(): boolean {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}
export function setSoundEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage unavailable: stays off */ }
}

/** Frequencies (Hz) and timing for each cue: short, quiet, two-note gestures. */
export const CUES: Record<Cue, { notes: number[]; step: number }> = {
  start: { notes: [523.25, 783.99], step: 0.07 },   // rising: listening
  stop:  { notes: [783.99, 523.25], step: 0.07 },   // falling: stopped
  ready: { notes: [659.25, 987.77], step: 0.09 },   // results are ready
  saved: { notes: [587.33, 880.0, 1174.66], step: 0.07 },
  error: { notes: [329.63, 293.66], step: 0.11 },
};

let ctx: AudioContext | null = null;

export function playCue(cue: Cue): void {
  if (!soundEnabled() || typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const { notes, step } = CUES[cue];
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = t0 + i * step;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.05, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + step + 0.08);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + step + 0.1);
    });
  } catch { /* sound is optional */ }
}
