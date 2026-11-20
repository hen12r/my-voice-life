import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle, Bell, CalendarDays, Check, CheckSquare, Heart, Keyboard, Lightbulb, Mic, Pencil, RotateCcw, Square, StickyNote, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n, type TranslationKey } from '../lib/i18n';
import { commitItems, createNote, DEFAULT_REMINDER_TIME, listCategories, processAudio, processText, type ProcessResult, type ReviewedItem } from '../lib/api';
import { ITEM_TYPES, type ItemType } from '../../supabase/functions/_shared/extraction.ts';
import { getLanguage, isKnownLanguage, languageLabel } from '../../supabase/functions/_shared/languages.ts';
import type { Category } from '../lib/types';
import { browserTimeZone } from '../lib/dates';
import { DEFAULT_MAX_RECORDING_MS, formatDuration, useRecorder, type Recording } from '../voice/useRecorder';
import { Alert, Badge, Button, Card, cx, Field, Input, PageHeader, Select, Textarea } from '../components/ui';
import { LiveWaveform, VoiceOrb, type OrbMode } from '../components/VoiceOrb';
import { playCue } from '../lib/sound';

type Phase = 'input' | 'processing' | 'review' | 'saving' | 'done';

export default function Capture() {
  const { t } = useI18n();
  const { profile, usage, refreshUsage } = useAuth();
  const [params] = useSearchParams();
  const maxMs = usage ? usage.max_capture_seconds * 1000 : DEFAULT_MAX_RECORDING_MS;
  const recorder = useRecorder(maxMs);
  // Server-counted allowance. The server enforces it regardless; this only explains the state.
  const limitReached = !!usage && (usage.captures_used >= usage.captures_limit || usage.minutes_used >= usage.minutes_limit);
  const aiBlocked = !!usage && (!usage.ai_available || limitReached);
  const [phase, setPhase] = useState<Phase>('input');
  const [typed, setTyped] = useState('');
  const [showTyping, setShowTyping] = useState(params.get('mode') === 'text');
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [transcript, setTranscript] = useState('');
  const [items, setItems] = useState<ReviewedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [saveErrors, setSaveErrors] = useState<Record<number, string>>({});
  const [savedCount, setSavedCount] = useState(0);
  // Genuine request stages: 'uploading' while bytes are being sent (real progress), then
  // 'thinking' while the server transcribes and organises. The server returns one response,
  // so these two are the stages the app can actually observe.
  const [stage, setStage] = useState<'uploading' | 'thinking' | null>(null);
  const [uploadPct, setUploadPct] = useState(0);

  const timezone = profile?.timezone ?? browserTimeZone();
  // The user's spoken languages (Settings), sent as recognition hints; empty = automatic detection.
  const languages = useMemo(() => profile?.speech_languages ?? [], [profile?.speech_languages]);

  useEffect(() => { listCategories().then(setCategories).catch(() => undefined); }, []);

  const adopt = (res: ProcessResult) => {
    setResult(res);
    setTranscript(res.transcript);
    setItems(res.items.map((i) => ({
      ...i,
      include: true,
      // A reminder needs a time; make the default visible instead of silently applying it.
      time: i.type === 'reminder' && i.date && !i.time ? DEFAULT_REMINDER_TIME : i.time,
    })));
    setSaveErrors({});
    setPhase('review');
    playCue('ready');
  };

  const run = async (fn: () => Promise<ProcessResult>) => {
    setError(null);
    setPhase('processing');
    try { adopt(await fn()); } catch (e) { setError(errorMessage(t, e)); setPhase(result ? 'review' : 'input'); playCue('error'); }
    finally { setStage(null); void refreshUsage(); }
  };

  const handleRecording = (rec: Recording | null) => {
    if (!rec) return;
    setUploadPct(0);
    setStage('uploading');
    void run(() => processAudio(rec.blob, rec.durationMs, timezone, languages, {
      onUpload: (f) => setUploadPct(Math.round(f * 100)),
      onUploaded: () => setStage('thinking'),
    }));
  };

  const startRecording = async () => {
    setError(null);
    await recorder.start();
    recorder.waitForAutoStop().then(handleRecording);
  };
  const stopRecording = () => { playCue('stop'); void recorder.stop().then(handleRecording); };

  // Cue only once the microphone is really live (after permission was granted).
  useEffect(() => { if (recorder.state === 'recording') playCue('start'); }, [recorder.state]);

  const recorderError = useMemo(() => {
    const map: Record<string, TranslationKey> = { denied: 'capture.micDenied', no_device: 'capture.micMissing', unsupported: 'capture.micUnsupported', insecure: 'capture.micInsecure', busy: 'capture.micBusy', too_short: 'capture.tooShort', failed: 'errors.generic' };
    return recorder.error ? t(map[recorder.error]) : null;
  }, [recorder.error, t]);

  const update = (idx: number, patch: Partial<ReviewedItem>) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const blocked = (it: ReviewedItem) => it.include && ((it.type === 'reminder' || it.type === 'event') && !it.date || !it.title.trim());
  const selected = items.filter((i) => i.include);
  const canSave = selected.length > 0 && !items.some(blocked);

  const save = async () => {
    if (!result) return;
    setPhase('saving');
    const outcomes = await commitItems(items, { timezone, sessionId: result.session_id, language: result.language, categories });
    const errs: Record<number, string> = {};
    outcomes.filter((o) => !o.ok).forEach((o) => { errs[o.index] = errorMessage(t, o.error); });
    const ok = outcomes.filter((o) => o.ok).length;
    setSavedCount((c) => c + ok);
    if (ok > 0) playCue('saved');
    // Keep only failed items on screen so nothing is lost or double-saved.
    const failed = new Set(Object.keys(errs).map(Number));
    if (failed.size === 0) { setPhase('done'); return; }
    const remaining = items.map((it, i) => ({ it, i })).filter(({ i }) => failed.has(i));
    setItems(remaining.map(({ it }) => it));
    setSaveErrors(Object.fromEntries(remaining.map(({ i }, n) => [n, errs[i]])));
    setPhase('review');
  };

  const saveTranscriptAsNote = async () => {
    setError(null);
    try {
      await createNote({ body: transcript, title: transcript.slice(0, 60), language: result?.language ?? null, voice_session_id: result?.session_id ?? null });
      setSavedCount((c) => c + 1);
      setPhase('done');
    } catch (e) { setError(errorMessage(t, e)); }
  };

  const reset = () => { setPhase('input'); setResult(null); setItems([]); setTranscript(''); setTyped(''); setError(null); setSaveErrors({}); setSavedCount(0); recorder.reset(); };

  // ---------------- Render ----------------
  if (phase === 'done') {
    return (
      <div className="mx-auto max-w-xl animate-fade-up">
        <Card className="p-8 text-center">
          <div className="animate-pop mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check className="size-6" /></div>
          <h1 className="text-lg font-semibold">{t('capture.saved')} · {savedCount}</h1>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button onClick={reset} icon={<Mic className="size-4" />}>{t('capture.startOver')}</Button>
            <Link to="/app"><Button variant="secondary">{t('nav.dashboard')}</Button></Link>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === 'review' || phase === 'saving') {
    return (
      <div className="animate-fade-up">
        <PageHeader title={t('capture.review')} action={<Button variant="ghost" onClick={reset} icon={<RotateCcw className="size-4" />}>{t('capture.startOver')}</Button>} />
        {error && <div className="mb-4"><Alert>{error}</Alert></div>}
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <Card className="h-fit p-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('capture.transcript')}</h2>
              {result && <Badge tone="accent">{t('capture.detected')}: {languageLabel(result.language === 'other' || result.language === 'none' ? null : result.language)}</Badge>}
            </div>
            <Textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={8} aria-label={t('capture.transcript')} />
            <p className="mt-2 text-xs text-muted">{t('capture.correctHint')}</p>
            {result && getLanguage(result.language)?.voice !== 'verified' && <p className="mt-1 text-xs text-amber-700">{t('capture.voiceUnverified')}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={!transcript.trim() || transcript === result?.transcript || phase === 'saving' || aiBlocked}
                onClick={() => run(() => processText(transcript, timezone, result && isKnownLanguage(result.language) ? [result.language] : languages))}>{t('capture.reprocess')}</Button>
              <Button variant="ghost" size="sm" disabled={!transcript.trim() || phase === 'saving'} onClick={saveTranscriptAsNote}>{t('capture.saveAsNote')}</Button>
            </div>
            {result?.warnings.map((w) => <p key={w} className="mt-2 text-xs text-muted">{w}</p>)}
          </Card>

          <div className="space-y-3">
            {items.length === 0 && <Card className="p-6 text-sm text-muted">{t('capture.nothingFound')}</Card>}
            {items.map((it, idx) => (
              <ReviewCard key={idx} index={idx} item={it} categories={categories} error={saveErrors[idx]} blocked={blocked(it)} onChange={(p) => update(idx, p)} />
            ))}
            {items.length > 0 && (
              <div className="sticky bottom-20 flex items-center justify-between gap-3 rounded-2xl border border-line bg-white/95 p-3 shadow-sm backdrop-blur lg:bottom-4">
                <span className="text-sm text-muted" aria-live="polite">{t('capture.keeping')} {selected.length} / {items.length}</span>
                <Button onClick={save} disabled={!canSave} loading={phase === 'saving'} icon={<Check className="size-4" />}>{t('capture.saveSelected')}</Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const recording = recorder.state === 'recording';
  const processing = phase === 'processing';
  const orbMode: OrbMode = processing ? (stage === 'uploading' ? 'uploading' : 'thinking')
    : recording ? 'recording' : recorder.state === 'requesting' ? 'requesting' : aiBlocked ? 'disabled' : 'idle';
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t('capture.title')} subtitle={t('capture.subtitle')} />
      {usage && usage.ai_available && <AllowanceBar usage={usage} />}
      {usage && !usage.ai_available && (
        <div className="mb-4"><Alert kind="info">
          {usage.ai_paused_message || t(usage.ai_mode === 'off' ? 'errors.ai_paused' : 'errors.ai_test_mode')}{' '}
          <Link to="/app/notes" className="font-medium underline">{t('usage.writeInstead')}</Link>
        </Alert></div>
      )}
      {usage && usage.ai_available && limitReached && (
        <div className="mb-4"><Alert kind="info">
          {t(usage.captures_used >= usage.captures_limit ? 'errors.quota_captures' : 'errors.quota_minutes')}{' '}
          <Link to="/app/notes" className="font-medium underline">{t('usage.writeInstead')}</Link>
        </Alert></div>
      )}
      <Card className="flex flex-col items-center overflow-hidden px-6 pt-6 pb-8">
        <VoiceOrb mode={orbMode} readLevel={recorder.readLevel} onPress={() => (recording ? stopRecording() : void startRecording())}
          label={recording ? t('capture.stop') : t('capture.start')}>
          {recording ? <Square className="size-9 fill-current" /> : <Mic className="size-11" />}
        </VoiceOrb>

        <LiveWaveform active={recording} readLevel={recorder.readLevel} />

        <div className="mt-2 min-h-12 text-center text-sm" aria-live="polite">
          {recording && <span className="inline-flex items-center gap-2 font-medium tabular-nums text-accent-700"><span className="size-2 rounded-full bg-red-500" aria-hidden />{t('capture.listening')} {formatDuration(recorder.elapsedMs)} / {formatDuration(maxMs)}</span>}
          {recorder.state === 'requesting' && <span className="text-muted">{t('capture.allowMic')}</span>}
          {processing && (
            <div className="animate-fade-up space-y-1">
              <p className="font-medium text-ink">{t('capture.understanding')}</p>
              <p className="text-xs text-muted">
                {stage === 'uploading' ? (uploadPct > 0 ? `${t('capture.stageUploading')} ${uploadPct}%` : `${t('capture.stageUploading')}…`) : stage === 'thinking' ? t('capture.stageThinking') : t('capture.stageOrganising')}
              </p>
            </div>
          )}
          {!recording && !processing && recorder.state !== 'requesting' && <span className="text-muted">{aiBlocked ? '' : t('capture.tapToSpeak')}</span>}
        </div>

        {recording && (
          <div className="mt-3 flex gap-2 animate-fade-up">
            <Button variant="secondary" className="press whitespace-nowrap" onClick={recorder.cancel} icon={<X className="size-4" />} aria-label={t('capture.cancel')}>{t('capture.cancelShort')}</Button>
            <Button className="press whitespace-nowrap" onClick={stopRecording} icon={<Square className="size-4" />} aria-label={t('capture.stop')}>{t('capture.finish')}</Button>
          </div>
        )}

        <div className="mt-6 w-full space-y-3">
          {recorderError && <Alert>{recorderError}</Alert>}
          {recorder.hitLimit && <Alert kind="info">{t('capture.maxReached')}</Alert>}
          {error && <Alert>{error}</Alert>}
        </div>
        <p className="mt-4 max-w-md text-center text-xs text-muted">{t('capture.privacy')}</p>
      </Card>

      <div className="mt-6">
        {!showTyping ? (
          <Button variant="ghost" onClick={() => setShowTyping(true)} icon={<Keyboard className="size-4" />}>{t('capture.typeInstead')}</Button>
        ) : (
          <Card className="p-5">
            <Textarea value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('capture.typePlaceholder')} rows={4} maxLength={10000} aria-label={t('capture.typeInstead')} autoFocus />
            <div className="mt-3 flex justify-end">
              <Button disabled={!typed.trim() || processing || recording || aiBlocked} loading={processing} onClick={() => run(() => processText(typed, timezone, languages))}>{t('capture.process')}</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

const TYPE_ICON: Record<ItemType, typeof CheckSquare> = {
  task: CheckSquare, reminder: Bell, event: CalendarDays, note: StickyNote, idea: Lightbulb, personal_info: Heart,
};

function ReviewCard({ item, index, categories, error, blocked, onChange }: {
  item: ReviewedItem; index: number; categories: Category[]; error?: string; blocked: boolean; onChange: (p: Partial<ReviewedItem>) => void;
}) {
  const { t, locale } = useI18n();
  // Items that cannot be saved as they are (e.g. a reminder without a date) open for editing.
  const [editing, setEditing] = useState(blocked);
  const [justKept, setJustKept] = useState(false);
  const dated = item.type === 'task' || item.type === 'reminder' || item.type === 'event';
  const Icon = TYPE_ICON[item.type];
  const when = item.date ? new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${item.date}T12:00:00`)) : null;
  const keep = () => { onChange({ include: true }); setJustKept(true); };

  if (!item.include) {
    return (
      <div className="animate-fade-up flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-4 py-3 text-sm text-muted">
        <span className="min-w-0 truncate"><span className="line-through">{item.title}</span></span>
        <Button variant="ghost" size="sm" onClick={keep} icon={<RotateCcw className="size-4" />}>{t('capture.undo')}</Button>
      </div>
    );
  }

  return (
    <Card as="article" className={cx('animate-card-in p-4 transition-shadow hover:shadow-md', blocked && 'ring-1 ring-amber-300')} style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700" aria-hidden><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{t(`type.${item.type}` as TranslationKey)}</p>
          <p className="mt-0.5 font-medium leading-snug break-words">{item.title}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {when && <Badge tone="accent">{when}{item.time ? ` · ${item.time}` : ''}</Badge>}
            {item.category && <Badge>{item.category}</Badge>}
            {item.priority === 'high' && <Badge tone="warn">{t('capture.important')}</Badge>}
          </div>
        </div>
        {justKept && <span className="animate-pop mt-1 flex size-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-600" aria-hidden><Check className="size-3.5" /></span>}
      </div>

      {editing && (
        <div className="animate-fade-up mt-4 space-y-3 border-t border-line pt-4">
          <div className="flex gap-2">
            <div className="w-32 shrink-0 sm:w-40">
              <Select value={item.type} onChange={(e) => onChange({ type: e.target.value as ItemType })} aria-label={t('capture.kind')}>
                {ITEM_TYPES.map((ty) => <option key={ty} value={ty}>{t(`type.${ty}` as TranslationKey)}</option>)}
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <Input value={item.title} onChange={(e) => onChange({ title: e.target.value })} aria-label={t('common.title')} maxLength={300} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('common.category')}>
              <Select value={item.category ?? ''} onChange={(e) => onChange({ category: e.target.value || null })}>
                <option value="">{t('common.none')}</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </Select>
            </Field>
            {dated && (
              <>
                <Field label={t('common.date')}>
                  <Input type="date" value={item.date ?? ''} onChange={(e) => onChange({ date: e.target.value || null, date_confidence: 'explicit' })} />
                </Field>
                <Field label={t('common.time')}>
                  <Input type="time" value={item.time ?? ''} onChange={(e) => onChange({ time: e.target.value || null })} />
                </Field>
              </>
            )}
          </div>
          <Textarea value={item.body ?? ''} onChange={(e) => onChange({ body: e.target.value || null })} rows={2} aria-label={t('common.details')} placeholder={t('common.details')} />
        </div>
      )}

      {item.date_text && <p className="mt-2 text-xs text-muted">“{item.date_text}”</p>}
      {item.warnings.filter((w) => !(item.date && /choose a date|needs a date/.test(w))).map((w) => (
        <p key={w} className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700"><AlertTriangle className="size-3.5 shrink-0" />{w}</p>
      ))}
      {blocked && <p className="mt-1.5 text-xs font-medium text-red-700">{t('capture.needsDate')}</p>}
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" className="press" onClick={() => setEditing((e) => !e)} icon={<Pencil className="size-4" />} aria-expanded={editing}>
          {editing ? t('capture.doneEditing') : t('common.edit')}
        </Button>
        <Button variant="ghost" size="sm" className="press text-red-700" onClick={() => onChange({ include: false })} icon={<X className="size-4" />}>{t('capture.reject')}</Button>
      </div>
    </Card>
  );
}

function AllowanceBar({ usage }: { usage: import('../lib/types').MyUsage }) {
  const { t, locale } = useI18n();
  const capturesLeft = Math.max(0, usage.captures_limit - usage.captures_used);
  const minutesLeft = Math.max(0, Math.floor((usage.minutes_limit - usage.minutes_used) * 10) / 10);
  const pct = Math.min(100, (usage.captures_used / usage.captures_limit) * 100);
  return (
    <div className="mb-4 rounded-2xl border border-line bg-white px-4 py-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span><strong className="tabular-nums">{capturesLeft}</strong> / {usage.captures_limit} {t('usage.capturesLeft')}</span>
        <span className="text-xs text-muted">
          <span className="tabular-nums">{minutesLeft}</span> {t('usage.minutesLeft')} · {t('usage.resets')} {new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(usage.resets_at))}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={usage.captures_limit} aria-valuenow={usage.captures_used}>
        <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-amber-500' : 'bg-accent-500')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
