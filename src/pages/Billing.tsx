import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, CreditCard, ExternalLink, Receipt, Sparkles } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { changePlan, getBillingInfo, getInvoices, getSubscription, openBillingPortal } from '../lib/api';
import { formatStripeAmount } from '../lib/money';
import { planFeatures, planNameKey } from '../lib/plans';
import type { BillingInfo, Invoice, PaidPlan, Subscription } from '../lib/types';
import { hasLiveSubscription } from './Pricing';
import { Alert, Badge, Button, Card, CardHeader, PageHeader, Spinner } from '../components/ui';

// Billing page. Everything shown comes from the server: the plan from effective_plan()
// (mvl_my_usage), the subscription row (written only by the verified Stripe webhook), invoices
// from Stripe via the billing function. Nothing here can change a plan by itself: changes and
// cancellations happen on Stripe's own pages, then Stripe's webhook updates the database.
export default function Billing() {
  const { t, locale } = useI18n();
  const { usage, refreshUsage } = useAuth();
  const [params] = useSearchParams();
  const [sub, setSub] = useState<Subscription | null | undefined>(undefined);
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshUsage();
    getSubscription().then(setSub).catch(() => setSub(null));
    getBillingInfo().then(setInfo).catch(() => setInfo({ configured: false, test_mode: false, prices: [], limits: {} }));
    getInvoices().then(setInvoices).catch((e) => { setInvoices([]); setInvoiceError(errorMessage(t, e)); });
  }, []);

  const plan = usage?.plan ?? 'free';
  const live = hasLiveSubscription(sub ?? null);
  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: 'long' }) : null);
  const periodEnd = date(sub?.current_period_end);
  const other: PaidPlan | null = plan === 'plus' ? 'pro' : plan === 'pro' ? 'plus' : null;
  const otherPrice = other ? info?.prices.find((p) => p.plan === other) : undefined;

  const go = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setError(null);
    try { window.location.assign(await fn()); } catch (e) { setError(errorMessage(t, e)); setBusy(null); }
  };

  if (!usage || sub === undefined) return <div className="pt-10"><Spinner label={t('pricing.loading')} /></div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      {params.get('changed') === '1' && <Alert kind="info">{t('billing.changeSubmitted')}</Alert>}
      {error && <Alert>{error}</Alert>}

      <Card>
        <CardHeader title={t('billing.currentPlan')} icon={<Sparkles className="size-4 text-accent-600" />} />
        <div className="space-y-4 px-5 pb-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={plan === 'free' ? 'neutral' : 'accent'}>{t(planNameKey(plan))}</Badge>
            {sub && plan !== 'free' && <Badge tone={sub.status === 'active' || sub.status === 'trialing' ? 'ok' : 'warn'}>{t(`billing.status.${sub.status}` as Parameters<typeof t>[0]) || sub.status}</Badge>}
          </div>
          {sub?.status === 'past_due' && <Alert>{t('billing.pastDue')}</Alert>}
          {sub?.status === 'unpaid' && <Alert>{t('billing.unpaid')}</Alert>}
          {plan !== 'free' && periodEnd && (
            <p className="text-ink">{t(sub?.cancel_at_period_end ? 'settings.endsOn' : 'settings.renews').replace('{date}', periodEnd)}</p>
          )}
          {plan === 'free' && <p className="text-muted">{t('billing.freeExplain')}</p>}
          <ul className="space-y-2">
            {planFeatures(t, info?.limits[plan], locale).map((f) => (
              <li key={f} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />{f}</li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap">
            {plan === 'free' && <Link to="/pricing"><Button className="w-full" icon={<Sparkles className="size-4" />}>{t('billing.seePlans')}</Button></Link>}
            {live && other && otherPrice && (
              <Button variant={other === 'pro' ? 'primary' : 'secondary'} loading={busy === 'change'} disabled={busy !== null} onClick={() => go('change', () => changePlan(other))}>
                {t(other === 'pro' ? 'pricing.upgradeTo' : 'pricing.downgradeTo').replace('{plan}', t(planNameKey(other)))}
                {' · '}{formatStripeAmount(otherPrice.amount, otherPrice.currency, locale)}{t('pricing.perMonth')}
              </Button>
            )}
            {sub?.has_billing_account && (
              <Button variant="secondary" loading={busy === 'portal'} disabled={busy !== null} icon={<CreditCard className="size-4" />} onClick={() => go('portal', openBillingPortal)}>
                {t(live ? 'billing.manageOrCancel' : 'pricing.manage')}
              </Button>
            )}
          </div>
          {live && <p className="text-xs text-muted">{t('billing.portalNote')}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title={t('billing.usageTitle')} />
        <div className="space-y-3 px-5 pb-5 text-sm">
          <CapLine label={t('billing.usageReminders')} used={usage.active_reminders} cap={usage.max_active_reminders} />
          <CapLine label={t('billing.usageEvents')} used={usage.upcoming_events} cap={usage.max_upcoming_events} />
          <CapLine label={t('billing.usageVoiceToday')} used={usage.byoai_used_today} cap={usage.byoai_captures_per_day} />
          <p className="text-xs text-muted">
            {t('billing.aiBilledSeparately')}{' '}
            <a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-700 hover:underline">
              {t('billing.openaiUsage')}<ExternalLink className="size-3" aria-hidden />
            </a>
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('billing.invoices')} icon={<Receipt className="size-4 text-accent-600" />} />
        <div className="px-5 pb-5 text-sm">
          {invoices === null ? <Spinner /> : invoices.length === 0 ? (
            <p className="text-muted">{invoiceError && sub?.has_billing_account ? invoiceError : t('billing.noInvoices')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {invoices.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="text-ink">{date(inv.created)}{inv.number ? <span className="ml-2 text-xs text-muted">{inv.number}</span> : null}</span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{inv.currency ? formatStripeAmount(inv.amount, inv.currency, locale) : ''}</span>
                    <Badge tone={inv.status === 'paid' ? 'ok' : inv.status === 'open' ? 'warn' : 'neutral'}>{t(`billing.invoice.${inv.status ?? 'unknown'}` as Parameters<typeof t>[0]) || inv.status}</Badge>
                    {inv.url && <a href={inv.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-700 hover:underline">{t('billing.view')}<ExternalLink className="size-3" aria-hidden /></a>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function CapLine({ label, used, cap }: { label: string; used: number | undefined; cap: number | null | undefined }) {
  const { t } = useI18n();
  if (used === undefined) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums text-ink">{cap == null ? `${used} · ${t('billing.noCap')}` : `${used} / ${cap}`}</span>
    </div>
  );
}
