import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreditCard, LogOut, Plus, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { createCategory, deleteAccount, deleteCategory, getSubscription, updateProfile } from '../lib/api';
import { planNameKey } from '../lib/plans';
import { AiProviderCard } from '../components/AiProviderCard';
import { InstallCard } from '../pwa/InstallCard';
import { AppearanceCard } from '../components/AppearanceCard';
import { setOnboarded } from '../lib/onboarding';
import { ExportCard } from '../components/ExportCard';
import { NotificationsCard } from '../pwa/NotificationsCard';
import { useCategories } from '../lib/useCategories';
import type { Profile, Subscription, UiLanguage } from '../lib/types';
import { getLanguage, interfaceLanguages, LANGUAGES, MAX_SPEECH_LANGUAGES, sanitizeSpeechLanguages } from '../../supabase/functions/_shared/languages.ts';
import { browserTimeZone, isValidTimeZone } from '../lib/dates';
import { supabase } from '../lib/supabase';
import { playCue, setSoundEnabled, soundEnabled } from '../lib/sound';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select } from '../components/ui';


export default function Settings() {
  const { t, locale } = useI18n();
  const { profile, setProfile, session, usage, refreshUsage, signOut } = useAuth();
  const navigate = useNavigate();
  const { categories, setCategories } = useCategories();
  const [form, setForm] = useState<Profile | null>(profile);
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [catError, setCatError] = useState<string | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sound, setSound] = useState(soundEnabled());

  useEffect(() => { setForm(profile); }, [profile]);
  useEffect(() => { getSubscription().then(setSub).catch(() => undefined); void refreshUsage(); }, []);

  if (!form) return null;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setForm({ ...form, [k]: v });
  const spoken = sanitizeSpeechLanguages(form.speech_languages ?? []);
  const setSpoken = (codes: string[]) => set('speech_languages', sanitizeSpeechLanguages(codes));
  const uiChoices = interfaceLanguages();
  // Keep a saved interface language visible even if it has no translation yet.
  const currentUi = getLanguage(form.ui_language);
  if (currentUi && !uiChoices.includes(currentUi)) uiChoices.push(currentUi);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValidTimeZone(form.timezone)) { setStatus({ kind: 'error', msg: `${t('settings.timezone')}: ${form.timezone}` }); return; }
    setSaving(true); setStatus(null);
    try {
      const updated = await updateProfile(form.id, {
        display_name: form.display_name?.trim() || null, ui_language: form.ui_language, timezone: form.timezone,
        speech_languages: spoken,
        // Legacy single field kept in step for older clients: 'auto' or the first spoken language.
        speech_language: spoken[0] ?? 'auto',
      });
      setProfile(updated as Profile);
      setStatus({ kind: 'success', msg: t('settings.saved') });
    } catch (err) { setStatus({ kind: 'error', msg: errorMessage(t, err) }); } finally { setSaving(false); }
  };

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCat.trim()) return;
    setCatError(null);
    try { const c = await createCategory(newCat); setCategories([...categories, c]); setNewCat(''); } catch (err) { setCatError(errorMessage(t, err)); }
  };
  const removeCategory = async (id: string) => {
    if (!confirm(t('common.confirmDelete'))) return;
    try { await deleteCategory(id); setCategories(categories.filter((c) => c.id !== id)); } catch (err) { setCatError(errorMessage(t, err)); }
  };

  // The plan shown is the one the SERVER computes (effective_plan), not a client-side guess.
  const paid = !!usage && usage.plan !== 'free';
  const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString(locale, { dateStyle: 'long' }) : null;
  const paymentProblem = sub?.has_billing_account && (sub.status === 'past_due' || sub.status === 'unpaid');
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('settings.title')} subtitle={session?.user.email} action={usage?.is_admin
        ? <Link to="/app/admin"><Button variant="secondary" icon={<ShieldCheck className="size-4" />}>{t('nav.admin')}</Button></Link>
        : undefined} />

      <Card>
        <CardHeader title={t('settings.profile')} />
        <form onSubmit={save} className="space-y-4 px-5 pb-5">
          <Field label={t('auth.name')}><Input value={form.display_name ?? ''} maxLength={80} onChange={(e) => set('display_name', e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.language')}>
              <Select value={form.ui_language} onChange={(e) => set('ui_language', e.target.value as UiLanguage)}>
                {uiChoices.map((l) => (
                  <option key={l.code} value={l.code}>{l.nativeName}{l.ui === 'draft' ? ` (${t('settings.uiDraft')})` : ''}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('settings.speech')} hint={t('settings.speechHint')}>
            <div className="space-y-2">
              {spoken.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {spoken.map((code) => {
                    const l = getLanguage(code)!;
                    return (
                      <li key={code} className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-1.5 pl-3 text-sm">
                        <span dir={l.direction}>{l.nativeName}</span>
                        <Badge tone={l.voice === 'verified' ? 'ok' : 'warn'}>{t(`settings.voice.${l.voice}`)}</Badge>
                        <button type="button" onClick={() => setSpoken(spoken.filter((c) => c !== code))} className="-m-1 rounded-full p-1.5 text-muted hover:bg-canvas hover:text-red-600"
                          aria-label={`${t('settings.removeLanguage')} ${l.nativeName}`}><X className="size-3.5" /></button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {spoken.length === 0 && <p className="text-sm text-muted">{t('settings.speechAuto')}</p>}
              {spoken.length < MAX_SPEECH_LANGUAGES && (
                <Select value="" onChange={(e) => e.target.value && setSpoken([...spoken, e.target.value])} aria-label={t('settings.addLanguage')}>
                  <option value="">{t('settings.addLanguage')}</option>
                  {LANGUAGES.filter((l) => !spoken.includes(l.code)).map((l) => (
                    <option key={l.code} value={l.code}>{l.nativeName} — {l.name} ({t(`settings.voice.${l.voice}`)})</option>
                  ))}
                </Select>
              )}
            </div>
          </Field>
          <Field label={t('settings.timezone')}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Africa/Kigali" />
              <Button type="button" variant="secondary" onClick={() => set('timezone', browserTimeZone())} className="shrink-0">{t('settings.useBrowserTz')}</Button>
            </div>
          </Field>
          {status && <Alert kind={status.kind}>{status.msg}</Alert>}
          <div className="flex justify-end"><Button type="submit" loading={saving}>{t('common.save')}</Button></div>
        </form>
      </Card>

      <Card>
        <CardHeader title={t('settings.categories')} />
        <div className="px-5 pb-5">
          <ul className="mb-4 flex flex-wrap gap-2">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-1.5 pl-3 text-sm">
                <span className="size-2 rounded-full" style={{ background: c.color ?? '#8b6cff' }} aria-hidden />{c.name}
                <button onClick={() => removeCategory(c.id)} className="-m-1 rounded-full p-1.5 text-muted hover:bg-canvas hover:text-red-600" aria-label={`${t('common.delete')} ${c.name}`}><X className="size-3.5" /></button>
              </li>
            ))}
          </ul>
          <form onSubmit={addCategory} className="flex gap-2">
            <Input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder={t('settings.newCategory')} maxLength={40} aria-label={t('settings.newCategory')} />
            <Button type="submit" variant="secondary" icon={<Plus className="size-4" />} disabled={!newCat.trim()}>{t('common.add')}</Button>
          </form>
          {catError && <div className="mt-3"><Alert>{catError}</Alert></div>}
        </div>
      </Card>

      <NotificationsCard />

      <AppearanceCard />

      <AiProviderCard />

      <InstallCard />

      <Card>
        <CardHeader title={t('settings.plan')} icon={<Sparkles className="size-4 text-accent-600" />} />
        <div className="space-y-3 px-5 pb-5 text-sm">
          <Badge tone={paid ? 'accent' : 'neutral'}>{t(planNameKey(usage?.plan ?? 'free'))}</Badge>
          {paymentProblem && <Alert>{t('settings.paymentProblem')}</Alert>}
          {paid && periodEnd && (
            <p className="text-sm text-ink">{t(sub?.cancel_at_period_end ? 'settings.endsOn' : 'settings.renews').replace('{date}', periodEnd)}</p>
          )}
          {usage && (
            <>
              <p className="text-xs font-medium text-muted">{t('settings.staffPlatformAi')}</p>
              <UsageMeter label={t('settings.aiCaptures')} used={usage.captures_used} limit={usage.captures_limit} />
              <UsageMeter label={t('settings.audioMinutes')} used={usage.minutes_used} limit={usage.minutes_limit} />
            </>
          )}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Link to="/app/billing"><Button variant="secondary" className="w-full" icon={<CreditCard className="size-4" />}>{t('settings.billingLink')}</Button></Link>
            {!paid && !paymentProblem && <Link to="/pricing"><Button className="w-full" icon={<Sparkles className="size-4" />}>{t('settings.upgrade')}</Button></Link>}
          </div>
        </div>
      </Card>

      <ExportCard />

      <Card>
        <CardHeader title={t('settings.privacy')} icon={<ShieldCheck className="size-4 text-accent-600" />} />
        <div className="space-y-4 px-5 pb-5 text-sm">
          <p className="text-muted">{t('settings.audioPolicy')}</p>
          <p className="flex gap-4 text-xs"><Link to="/privacy" className="text-accent-700 hover:underline">{t('legal.privacy')}</Link><Link to="/terms" className="text-accent-700 hover:underline">{t('legal.terms')}</Link></p>
          <Button variant="secondary" className="text-red-700" onClick={() => setDeleting(true)} icon={<Trash2 className="size-4" />}>{t('settings.deleteAccount')}</Button>
        </div>
      </Card>

      <Card>
        <label className="flex cursor-pointer items-start justify-between gap-4 px-5 py-4">
          <span>
            <span className="block text-sm font-semibold text-ink">{t('settings.sound')}</span>
            <span className="mt-1 block text-xs text-muted">{t('settings.soundHint')}</span>
          </span>
          <input type="checkbox" role="switch" className="mt-1 size-5 shrink-0 accent-accent-600" checked={sound}
            onChange={(e) => { setSoundEnabled(e.target.checked); setSound(e.target.checked); if (e.target.checked) playCue('ready'); }} />
        </label>
      </Card>

      <Button variant="ghost" className="w-full" icon={<Sparkles className="size-4" />} onClick={() => { setOnboarded(false); navigate('/app/welcome'); }}>{t('settings.replayIntro')}</Button>

      {/* Sign out is here so it is reachable on phones (the sidebar is desktop-only). */}
      <Button variant="secondary" className="w-full" icon={<LogOut className="size-4" />} onClick={async () => { await signOut(); navigate('/'); }}>{t('nav.signout')}</Button>

      {deleting && <DeleteAccount onClose={() => setDeleting(false)} onDeleted={async () => { await supabase.auth.signOut(); navigate('/'); }} />}
    </div>
  );
}

function DeleteAccount({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true); setError(null);
    try { await deleteAccount(); onDeleted(); } catch (e) { setError(errorMessage(t, e)); setLoading(false); }
  };
  return (
    <Modal open onClose={onClose} title={t('settings.deleteAccount')}>
      <p className="mb-4 text-sm text-muted">{t('settings.deleteConfirm')}</p>
      <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="DELETE" autoFocus />
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={text !== 'DELETE'} loading={loading} onClick={go}>{t('common.delete')}</Button>
      </div>
    </Modal>
  );
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (used / Math.max(limit, 1)) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted"><span>{label}</span><span className="tabular-nums">{used} / {limit}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-amber-500' : 'bg-accent-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
