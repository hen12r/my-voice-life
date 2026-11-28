import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, Check, Info, Lock, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { changePlan, getBillingInfo, getSubscription, startCheckout } from '../lib/api';
import { formatStripeAmount } from '../lib/money';
import { PLANS, planFeatures, planNameKey } from '../lib/plans';
import type { BillingInfo, BillingInterval, PaidPlan, Plan, Subscription } from '../lib/types';
import { Logo } from '../components/AppShell';
import { Alert, Button, Card, cx, Spinner } from '../components/ui';

/** True while a subscription still exists at Stripe (then plan changes go through Stripe's portal). */
export function hasLiveSubscription(sub: Subscription | null): boolean {
  if (!sub?.has_billing_account || sub.plan === 'free') return false;
  return ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(sub.status);
}

export default function Pricing() {
  const { t, locale } = useI18n();
  const { session, usage } = useAuth();
  const [params] = useSearchParams();
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState<PaidPlan | null>(null);
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBillingInfo().then(setInfo)
      .catch((e) => { setError(errorMessage(t, e)); setInfo({ configured: false, test_mode: false, prices: [], limits: {} }); });
  }, []);
  useEffect(() => { if (session) getSubscription().then(setSub).catch(() => undefined); }, [session]);
  // A yearly subscriber sees yearly prices first.
  useEffect(() => { if (sub?.billing_interval === 'year') setInterval('year'); }, [sub?.billing_interval]);

  // The plan shown as "current" is the SERVER's (effective_plan), never a browser guess.
  const current: Plan | null = session ? (usage?.plan ?? 'free') : null;
  const live = hasLiveSubscription(sub);
  const hasYearly = !!info?.prices.some((p) => p.interval === 'year');
  const currentInterval: BillingInterval | null = sub?.billing_interval === 'year' ? 'year' : sub?.billing_interval === 'month' ? 'month' : null;

  const go = async (plan: PaidPlan, fn: () => Promise<string>) => {
    setBusy(plan); setError(null);
    try { window.location.assign(await fn()); } catch (e) { setError(errorMessage(t, e)); setBusy(null); }
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="bg-navy-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <Link to={session ? '/app' : '/'} aria-label="My Voice Life"><Logo light /></Link>
          {session
            ? <Link to="/app/billing" className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white"><ArrowLeft className="size-4" />{t('pricing.backToBilling')}</Link>
            : <Link to="/login" className="rounded-xl px-4 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white">{t('landing.signin')}</Link>}
        </div>
        <div className="mx-auto max-w-6xl px-5 pt-4 pb-24 text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('pricing.title')}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-white/65 sm:text-base">{t('pricing.subtitle')}</p>
        </div>
      </header>

      <main className="mx-auto -mt-16 max-w-6xl space-y-4 px-4 pb-16 sm:px-5">
        <div role="note" className="flex gap-3 rounded-2xl border border-accent-100 bg-surface p-4 text-sm text-ink shadow-sm">
          <Info className="mt-0.5 size-5 shrink-0 text-accent-600" aria-hidden />
          <div>
            <p className="font-semibold">{t('pricing.byoaiTitle')}</p>
            <p className="mt-1 text-muted">{t('pricing.byoaiBody')}</p>
          </div>
        </div>
        {params.get('checkout') === 'cancelled' && <Alert kind="info">{t('pricing.cancelled')}</Alert>}
        {info?.test_mode && <Alert kind="info">{t('pricing.testMode')}</Alert>}
        {info && !info.configured && <Alert kind="info">{t('pricing.notAvailable')}</Alert>}
        {error && <Alert>{error}</Alert>}

        {hasYearly && (
          <div className="flex justify-center">
            <div role="radiogroup" aria-label={t('pricing.title')} className="inline-flex rounded-xl bg-surface p-1 text-sm shadow-sm ring-1 ring-line">
              {(['month', 'year'] as const).map((i) => (
                <button key={i} type="button" role="radio" aria-checked={interval === i} onClick={() => setInterval(i)}
                  className={cx('rounded-lg px-4 py-1.5 font-medium transition-colors', interval === i ? 'bg-navy-900 text-white dark:bg-accent-600' : 'text-muted hover:text-ink')}>
                  {t(i === 'month' ? 'pricing.monthly' : 'pricing.yearly')}
                </button>
              ))}
            </div>
          </div>
        )}

        {!info ? <Card className="p-10"><Spinner label={t('pricing.loading')} /></Card> : (
          <div className="grid gap-4 lg:grid-cols-3">
            {PLANS.map((plan) => {
              const price = plan === 'free' ? null : info.prices.find((p) => p.plan === plan && p.interval === interval) ?? null;
              const isCurrent = current === plan;
              return (
                <Card key={plan} className={cx('flex flex-col p-6', plan === 'plus' && 'ring-2 ring-accent-500')}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
                      {plan !== 'free' && <Sparkles className="size-4 text-accent-600" aria-hidden />}{t(planNameKey(plan))}
                    </h2>
                    {isCurrent && <span className="rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700">{t('pricing.current')}</span>}
                  </div>
                  <p className="mt-4 text-3xl font-semibold text-ink">
                    {plan === 'free'
                      ? formatStripeAmount(0, info.prices[0]?.currency ?? 'USD', locale)
                      : price
                        ? <>{formatStripeAmount(price.amount, price.currency, locale)}<span className="ml-1 text-sm font-normal text-muted">{t(price.interval === 'year' ? 'pricing.perYear' : 'pricing.perMonth')}</span>
                            {price.interval === 'year' && <span className="mt-1 block text-sm font-normal text-muted">{t('pricing.perMonthEquiv').replace('{price}', formatStripeAmount(Math.round(price.amount / 12), price.currency, locale))}</span>}</>
                        : <span className="text-base font-normal text-muted">{t('pricing.planNotAvailable')}</span>}
                  </p>
                  <ul className="mt-5 flex-1 space-y-2.5 text-sm text-ink">
                    {planFeatures(t, info.limits[plan], locale).map((f) => (
                      <li key={f} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />{f}</li>
                    ))}
                  </ul>
                  <div className="mt-6 space-y-2">
                    <PlanAction plan={plan} signedIn={!!session} current={current} live={live} hasPrice={!!price}
                      interval={interval} currentInterval={currentInterval} busy={busy === plan} disabled={busy !== null}
                      onCheckout={(p) => go(p, () => startCheckout(p, interval))} onChange={(p) => go(p, () => changePlan(p, interval))} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
        <p className="flex items-center justify-center gap-1.5 pt-2 text-center text-xs text-muted"><Lock className="size-3.5" aria-hidden />{t('pricing.secure')}</p>
        <p className="flex justify-center gap-4 text-xs text-muted"><Link to="/terms" className="underline-offset-2 hover:underline">{t('legal.terms')}</Link><Link to="/privacy" className="underline-offset-2 hover:underline">{t('legal.privacy')}</Link></p>
      </main>
    </div>
  );
}

function PlanAction(p: {
  plan: Plan; signedIn: boolean; current: Plan | null; live: boolean; hasPrice: boolean; busy: boolean; disabled: boolean;
  interval: BillingInterval; currentInterval: BillingInterval | null;
  onCheckout: (plan: PaidPlan) => void; onChange: (plan: PaidPlan) => void;
}) {
  const { t } = useI18n();
  if (!p.signedIn) {
    if (p.plan === 'free') return <Link to="/register" className="block"><Button variant="secondary" className="w-full">{t('pricing.signupFirst')}</Button></Link>;
    return p.hasPrice ? <Link to="/login" state={{ from: '/pricing' }} className="block"><Button className="w-full">{t('pricing.signinToSubscribe')}</Button></Link> : null;
  }
  if (p.current === p.plan) {
    if (p.plan === 'free') return null;
    const samePlan = p.plan;
    // Same plan, other billing period (e.g. monthly → yearly): Stripe's confirm page, with proration.
    if (p.live && p.hasPrice && p.currentInterval && p.currentInterval !== p.interval) {
      return <Button className="w-full" loading={p.busy} disabled={p.disabled} onClick={() => p.onChange(samePlan)}>{t(p.interval === 'year' ? 'pricing.switchToYearly' : 'pricing.switchToMonthly')}</Button>;
    }
    return <Link to="/app/billing" className="block"><Button variant="secondary" className="w-full">{t('pricing.manage')}</Button></Link>;
  }
  if (p.plan === 'free') {
    // Going back to Free = cancelling, which only Stripe's portal does (from the Billing page).
    return <p className="text-center text-xs text-muted">{t('pricing.freeViaCancel')} <Link to="/app/billing" className="text-accent-700 underline">{t('nav.billing')}</Link></p>;
  }
  if (!p.hasPrice) return null;
  const plan = p.plan;
  return p.live
    ? <Button className="w-full" variant={plan === 'pro' ? 'primary' : 'secondary'} loading={p.busy} disabled={p.disabled} onClick={() => p.onChange(plan)}>
        {t(plan === 'pro' ? 'pricing.upgradeTo' : 'pricing.downgradeTo').replace('{plan}', t(planNameKey(plan)))}
      </Button>
    : <Button className="w-full" loading={p.busy} disabled={p.disabled} onClick={() => p.onCheckout(plan)}>
        {t('pricing.subscribeTo').replace('{plan}', t(planNameKey(plan)))}
      </Button>;
}
