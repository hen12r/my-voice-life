import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, Check, CreditCard, Lock, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { getBillingInfo, getSubscription, openBillingPortal, startCheckout } from '../lib/api';
import { formatStripeAmount } from '../lib/money';
import type { BillingInfo, Subscription } from '../lib/types';
import { Logo } from '../components/AppShell';
import { Alert, Button, Card, cx, Spinner } from '../components/ui';

/** True while a subscription still exists at Stripe (then the portal, not a new checkout, is offered). */
export function hasLiveSubscription(sub: Subscription | null): boolean {
  if (!sub?.has_billing_account || sub.plan !== 'premium') return false;
  return ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(sub.status);
}

export default function Pricing() {
  const { t, locale } = useI18n();
  const { session, usage } = useAuth();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBillingInfo().then((i) => {
      setInfo(i);
      if (!i.prices.some((p) => p.interval === 'month') && i.prices.some((p) => p.interval === 'year')) setInterval('year');
    }).catch((e) => { setError(errorMessage(t, e)); setInfo({ configured: false, test_mode: false, prices: [], limits: {} }); });
  }, []);
  useEffect(() => { if (session) getSubscription().then(setSub).catch(() => undefined); }, [session]);

  const premiumNow = usage?.plan === 'premium';
  const live = hasLiveSubscription(sub);
  const price = info?.prices.find((p) => p.interval === interval);
  const fmt = (key: Parameters<typeof t>[0], n: number | undefined) => (n === undefined ? null : t(key).replace('{n}', n.toLocaleString(locale)));

  const go = async (fn: () => Promise<string>) => {
    setBusy(true); setError(null);
    try { window.location.assign(await fn()); } catch (e) { setError(errorMessage(t, e)); setBusy(false); }
  };

  const features = (plan: 'free' | 'premium') => {
    const l = info?.limits[plan];
    return [fmt('pricing.captures', l?.ai_captures_per_month), fmt('pricing.minutes', l?.audio_minutes_per_month),
      fmt('pricing.maxLength', l?.max_capture_seconds), t('pricing.manual'), t('pricing.review')].filter(Boolean) as string[];
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="bg-navy-950 text-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
          <Link to={session ? '/app' : '/'} aria-label="My Voice Life"><Logo light /></Link>
          {session
            ? <Link to="/app/settings" className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white"><ArrowLeft className="size-4" />{t('pricing.backToApp')}</Link>
            : <Link to="/login" className="rounded-xl px-4 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white">{t('landing.signin')}</Link>}
        </div>
        <div className="mx-auto max-w-5xl px-5 pt-4 pb-24 text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('pricing.title')}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-white/65 sm:text-base">{t('pricing.subtitle')}</p>
        </div>
      </header>

      <main className="mx-auto -mt-16 max-w-5xl space-y-4 px-4 pb-16 sm:px-5">
        {params.get('checkout') === 'cancelled' && <Alert kind="info">{t('pricing.cancelled')}</Alert>}
        {info?.test_mode && <Alert kind="info">{t('pricing.testMode')}</Alert>}
        {error && <Alert>{error}</Alert>}

        {!info ? <Card className="p-10"><Spinner label={t('pricing.loading')} /></Card> : (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Free */}
            <Card className="flex flex-col p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-ink">{t('pricing.free')}</h2>
                {session && !premiumNow && <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-medium text-muted">{t('pricing.current')}</span>}
              </div>
              <p className="mt-4 text-3xl font-semibold text-ink">{info.prices[0] ? formatStripeAmount(0, info.prices[0].currency, locale) : t('pricing.freePrice')}</p>
              <FeatureList items={features('free')} />
              {!session && <Link to="/register" className="mt-6"><Button variant="secondary" className="w-full">{t('pricing.signupFirst')}</Button></Link>}
            </Card>

            {/* Premium */}
            <Card className="relative flex flex-col overflow-hidden p-6 ring-2 ring-accent-500">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-ink"><Sparkles className="size-4 text-accent-600" aria-hidden />{t('pricing.premium')}</h2>
                {premiumNow && <span className="rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700">{t('pricing.current')}</span>}
              </div>

              {info.configured && info.prices.length > 1 && (
                <div role="radiogroup" aria-label={t('pricing.title')} className="mt-4 inline-flex w-fit rounded-xl bg-canvas p-1 text-sm">
                  {(['month', 'year'] as const).filter((i) => info.prices.some((p) => p.interval === i)).map((i) => (
                    <button key={i} type="button" role="radio" aria-checked={interval === i} onClick={() => setInterval(i)}
                      className={cx('press rounded-lg px-3 py-1.5 font-medium transition-colors', interval === i ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink')}>
                      {t(i === 'month' ? 'pricing.monthly' : 'pricing.yearly')}
                    </button>
                  ))}
                </div>
              )}

              {price
                ? <p className="mt-4 text-3xl font-semibold text-ink">{formatStripeAmount(price.amount, price.currency, locale)}
                    <span className="ml-1 text-sm font-normal text-muted">{t(price.interval === 'month' ? 'pricing.perMonth' : 'pricing.perYear')}</span></p>
                : <p className="mt-4 text-sm text-muted">{t('pricing.notAvailable')}</p>}

              <FeatureList items={features('premium')} />

              <div className="mt-6 space-y-3">
                {!session && info.configured && <Link to="/login" state={{ from: '/pricing' }}><Button className="w-full">{t('pricing.signinToSubscribe')}</Button></Link>}
                {session && live && (
                  <Button className="w-full" variant="secondary" loading={busy} icon={<CreditCard className="size-4" />} onClick={() => go(openBillingPortal)}>{t('pricing.manage')}</Button>
                )}
                {session && !live && info.configured && price && (
                  <Button className="w-full" loading={busy} onClick={() => go(() => startCheckout(interval))}>{t('pricing.subscribe')}</Button>
                )}
              </div>
            </Card>
          </div>
        )}
        <p className="flex items-center justify-center gap-1.5 pt-2 text-center text-xs text-muted"><Lock className="size-3.5" aria-hidden />{t('pricing.secure')}</p>
        <p className="flex justify-center gap-4 text-xs text-muted"><Link to="/terms" className="underline-offset-2 hover:underline">{t('legal.terms')}</Link><Link to="/privacy" className="underline-offset-2 hover:underline">{t('legal.privacy')}</Link></p>
      </main>
    </div>
  );
}

function FeatureList({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 flex-1 space-y-2.5 text-sm text-ink">
      {items.map((f) => <li key={f} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />{f}</li>)}
    </ul>
  );
}
