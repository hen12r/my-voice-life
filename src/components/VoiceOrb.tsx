import { useEffect, useRef, type ReactNode } from 'react';

export type OrbMode = 'idle' | 'disabled' | 'requesting' | 'recording' | 'uploading' | 'thinking';

const BARS = 32;

/**
 * The signature microphone. While recording, it reacts to the REAL microphone level read from
 * the recorder's AnalyserNode via `readLevel` — rings, glow and scale all follow `--lvl`.
 * Nothing moves with audio unless audio is actually being captured: in every other mode the
 * level is 0 and only the slow idle "breathing" (or the processing sweep) runs.
 * The animation loop writes CSS variables directly (no React re-render per frame) and stops
 * as soon as recording ends.
 */
export function VoiceOrb({ mode, readLevel, onPress, label, children }: {
  mode: OrbMode;
  readLevel: () => number;
  onPress: () => void;
  label: string;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode !== 'recording') { host.style.setProperty('--lvl', '0'); return; }
    let raf = 0;
    let smoothed = 0;
    const loop = () => {
      // Fast attack, slower release: reacts to speech, settles calmly in silence.
      const lvl = readLevel();
      smoothed = lvl > smoothed ? smoothed + (lvl - smoothed) * 0.5 : smoothed + (lvl - smoothed) * 0.12;
      host.style.setProperty('--lvl', smoothed.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); host.style.setProperty('--lvl', '0'); };
  }, [mode, readLevel]);

  const busy = mode === 'requesting' || mode === 'uploading' || mode === 'thinking';
  return (
    <div ref={hostRef} className="orb" data-mode={mode}>
      <span className="orb-glow" aria-hidden />
      <span className="orb-ring orb-ring-3" aria-hidden />
      <span className="orb-ring orb-ring-2" aria-hidden />
      <span className="orb-ring orb-ring-1" aria-hidden />
      <button type="button" className="orb-core" onClick={onPress} disabled={mode === 'disabled' || busy}
        aria-label={label} aria-pressed={mode === 'recording'}>
        {children}
      </button>
    </div>
  );
}

/**
 * Scrolling waveform of the real input level (one bar per ~45 ms). Rendered only while
 * recording; it never shows invented data.
 */
export function LiveWaveform({ active, readLevel }: { active: boolean; readLevel: () => number }) {
  const barsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = barsRef.current;
    if (!active || !root) return;
    const bars = Array.from(root.children) as HTMLElement[];
    const history = new Array<number>(BARS).fill(0);
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 45) {
        last = t;
        history.shift();
        history.push(readLevel());
        for (let i = 0; i < BARS; i++) bars[i].style.transform = `scaleY(${Math.max(0.06, history[i]).toFixed(3)})`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); bars.forEach((b) => { b.style.transform = ''; }); };
  }, [active, readLevel]);

  if (!active) return <div className="wave" aria-hidden />;
  return (
    <div ref={barsRef} className="wave" aria-hidden>
      {Array.from({ length: BARS }, (_, i) => <span key={i} className="wave-bar" />)}
    </div>
  );
}
