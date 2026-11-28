import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Check, Mic, MicOff, PenLine, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { voiceAccess } from '../lib/plans';
import { setOnboarded } from '../lib/onboarding';
import { InstallCard } from '../pwa/InstallCard';
import { Alert, Button, Card } from '../components/ui';

type MicState = 'idle' | 'testing' | 'ok' | 'denied' | 'unsupported';

// First-run introduction: 4 short steps, always skippable. Everything it says about voice comes
// from the server (mvl_my_usage → voiceAccess), so it never promises a feature that is switched off.
export default function Welcome() {
  const { t } = useI18n();
  const { usage } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [mic, setMic] = useState<MicState>('idle');
  const total = 4;
  const access = usage ? voiceAccess(usage) : null;

  const finish = (to: string) => { setOnboarded(true); navigate(to, { replace: true }); };

  // Asks for the microphone only on this explicit tap, then stops it at once: nothing is recorded.
  const testMic = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setMic('unsupported'); return; }
    setMic('testing');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
      setMic('ok');
    } catch { setMic('denied'); }
  };

  return (
    <div className="mx-auto max-w-lg space-y-5 pt-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{t('welcome.step').replace('{n}', String(step + 1)).replace('{total}', String(total))}</span>
        <button type="button" onClick={() => finish('/app')} className="rounded-lg px-2 py-1 hover:text-ink">{t('welcome.skip')}</button>
      </div>
      <div className="flex gap-1.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent-500' : 'bg-line'}`} />)}
      </div>

      <Card className="animate-card-in space-y-4 p-6" as="div">
        {step === 0 && (
          <>
            <Sparkles className="size-7 text-accent-600" aria-hidden />
            <h1 className="text-xl font-semibold text-ink">{t('welcome.s1.title')}</h1>
            <p className="text-sm text-muted">{t('welcome.s1.body')}</p>
            <ol className="space-y-2 text-sm text-ink">
              {(['welcome.s1.p1', 'welcome.s1.p2', 'welcome.s1.p3'] as TranslationKey[]).map((k, i) => (
                <li key={k} className="flex items-center gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-50 text-xs font-semibold text-accent-700">{i + 1}</span>{t(k)}
                </li>
              ))}
            </ol>
          </>
        )}
        {step === 1 && (
          <>
            <Mic className="size-7 text-accent-600" aria-hidden />
            <h1 className="text-xl font-semibold text-ink">{t('welcome.s2.title')}</h1>
            <p className="text-sm text-muted">{t('welcome.s2.body')}</p>
            <Button variant="secondary" loading={mic === 'testing'} onClick={testMic} icon={<Mic className="size-4" />}>{t('welcome.s2.test')}</Button>
            {mic === 'ok' && <Alert kind="success">{t('welcome.s2.ok')}</Alert>}
            {mic === 'denied' && <Alert>{t('welcome.s2.denied')}</Alert>}
            {mic === 'unsupported' && <Alert kind="info">{t('welcome.s2.unsupported')}</Alert>}
          </>
        )}
        {step === 2 && (
          <>
            {access?.mode === 'blocked' ? <MicOff className="size-7 text-muted" aria-hidden /> : <Check className="size-7 text-accent-600" aria-hidden />}
            <h1 className="text-xl font-semibold text-ink">{t('welcome.s3.title')}</h1>
            {access && access.mode !== 'blocked'
              ? <Alert kind="success">{t('welcome.s3.on')}</Alert>
              : <>
                  <Alert kind="info">{t('welcome.s3.off')}</Alert>
                  {access?.mode === 'blocked' && <p className="text-xs text-muted">{t(access.reason as TranslationKey)}</p>}
                </>}
          </>
        )}
        {step === 3 && (
          <>
            <PenLine className="size-7 text-accent-600" aria-hidden />
            <h1 className="text-xl font-semibold text-ink">{t('welcome.s4.title')}</h1>
            <p className="text-sm text-muted">{t('welcome.s4.body')}</p>
          </>
        )}
      </Card>

      {step === 3 && <InstallCard />}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0} className={step === 0 ? 'invisible' : ''}>{t('welcome.back')}</Button>
        {step < total - 1
          ? <Button onClick={() => setStep((s) => s + 1)}>{t('welcome.next')}</Button>
          : <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => finish('/app')}>{t('welcome.done')}</Button>
              <Button onClick={() => finish('/app/notes?new=1')} icon={<PenLine className="size-4" />}>{t('welcome.firstNote')}</Button>
            </div>}
      </div>
      <p className="text-center text-xs text-muted"><Link to="/privacy" className="hover:underline">{t('legal.privacy')}</Link></p>
    </div>
  );
}
