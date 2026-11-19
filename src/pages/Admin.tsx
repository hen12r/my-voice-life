import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { AlertTriangle, Bell, Coins, Gauge, Power, RefreshCw, Trash2, Users } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n, type TranslationKey } from '../lib/i18n';
import {
  adminAckAlert, adminAddExpense, adminDeleteExpense, adminUpdatePlanLimits, adminUpdateSettings, getAdminFinance, getAdminUsage,
} from '../lib/api';
import type { AdminFinanceSummary, AdminUsageSummary, PlanLimits } from '../lib/types';
import { Alert, Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Select, Spinner } from '../components/ui';

const usd = (n: number, d = 4) => `$${Number(n ?? 0).toFixed(d)}`;
const monthStart = (ym: string) => `${ym}-01`;
const thisMonth = () => new Date().toISOString().slice(0, 7);

type Source = 'recorded' | 'projected' | 'estimate';
function SourceBadge({ source }: { source: Source }) {
  const { t } = useI18n();
  const map: Record<Source, { key: TranslationKey; tone: 'ok' | 'accent' | 'warn' }> = {
    recorded: { key: 'admin.labelRecorded', tone: 'ok' },
    projected: { key: 'admin.labelProjected', tone: 'accent' },
    estimate: { key: 'admin.labelEstimate', tone: 'warn' },
  };
  return <Badge tone={map[source].tone}>{t(map[source].key)}</Badge>;
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs"><span className="text-muted">{label}</span><span className="tabular-nums">{usd(value)} / {usd(max, 2)}</span></div>
      <div className="h-2.5 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-accent-500')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, source }: { label: string; value: ReactNode; source?: Source }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">{label}{source && <SourceBadge source={source} />}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default function Admin() {
  const { t, locale } = useI18n();
  const { usage: me } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [usage, setUsage] = useState<AdminUsageSummary | null>(null);
  const [finance, setFinance] = useState<AdminFinanceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, f] = await Promise.all([getAdminUsage(monthStart(month)), getAdminFinance(monthStart(month))]);
      setUsage(u); setFinance(f);
    } catch (e) { setError(errorMessage(t, e)); }
  }, [month, t]);
  // Only admins request admin data (the server would refuse anyone else anyway).
  useEffect(() => { if (me?.is_admin) void load(); }, [load, me?.is_admin]);

  // The server refuses non-admins anyway; this just avoids showing an empty page.
  if (me && !me.is_admin) return <Navigate to="/app" replace />;
  if (!usage || !finance) return error ? <Alert>{error}</Alert> : <Spinner label={t('common.loading')} />;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null); setNotice(null);
    try { await fn(); setNotice(t('admin.saved')); await load(); } catch (e) { setError(errorMessage(t, e)); }
  };
  const eur = (n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(n ?? 0);
  const openAlerts = usage.alerts.filter((a) => !a.acknowledged_at);
  const maxDay = Math.max(1, ...usage.by_day.map((d) => d.captures));
  const tot = usage.totals;

  return (
    <div className="space-y-6">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} action={
        <div className="flex items-end gap-2">
          <Field label={t('admin.month')}><Input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" /></Field>
          <Button variant="secondary" onClick={load} icon={<RefreshCw className="size-4" />} aria-label={t('admin.refresh')} />
        </div>} />
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {openAlerts.length > 0 && (
        <Card className="border-amber-300">
          <CardHeader title={t('admin.alerts')} icon={<Bell className="size-4 text-amber-600" />} />
          <ul className="divide-y divide-line px-5 pb-3">
            {openAlerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <AlertTriangle className={cx('size-4', a.threshold >= 1 ? 'text-red-600' : 'text-amber-600')} aria-hidden />
                <span className="flex-1">{a.period === 'day' ? t('admin.dailyBudget') : t('admin.monthlyBudget')} · {Math.round(a.threshold * 100)}% · {usd(a.spend_usd)} / {usd(a.budget_usd, 2)} · {new Date(a.created_at).toLocaleString(locale)}</span>
                <Button size="sm" variant="secondary" onClick={() => act(() => adminAckAlert(a.id))}>{t('admin.acknowledge')}</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <AiControls usage={usage} onSave={(p) => act(() => adminUpdateSettings(p))} />

      <Card>
        <CardHeader title={t('admin.usage')} icon={<Gauge className="size-4 text-accent-600" />} />
        <div className="grid grid-cols-2 gap-3 px-5 sm:grid-cols-4">
          <Stat label={t('admin.capturesOk')} value={tot.captures_ok} source="recorded" />
          <Stat label={t('admin.capturesFailed')} value={`${tot.captures_failed} (+${tot.captures_expired})`} source="recorded" />
          <Stat label={t('admin.refusals')} value={tot.refusals} source="recorded" />
          <Stat label={t('admin.inFlight')} value={tot.captures_in_flight} source="recorded" />
          <Stat label={t('admin.audioMinutes')} value={tot.audio_minutes} source="recorded" />
          <Stat label={t('admin.activeUsers')} value={tot.active_ai_users} source="recorded" />
          <Stat label={t('admin.estCost')} value={usd(tot.est_cost_usd)} source="estimate" />
          <Stat label={t('admin.providerCalls')} value={tot.provider_calls} source="recorded" />
        </div>
        <p className="px-5 pt-3 text-xs text-muted">{t('admin.tokens')}: <span className="tabular-nums">{tot.audio_tokens.toLocaleString(locale)} / {tot.text_in_tokens.toLocaleString(locale)} / {tot.output_tokens.toLocaleString(locale)} / {tot.thinking_tokens.toLocaleString(locale)}</span></p>
        <div className="grid gap-6 px-5 py-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted">{t('admin.byDay')}</h3>
            {usage.by_day.length === 0 ? <p className="text-sm text-muted">{t('admin.noData')}</p> : (
              <div className="flex h-32 items-end gap-1" role="img" aria-label={t('admin.byDay')}>
                {usage.by_day.map((d) => (
                  <div key={d.day} className="flex-1 rounded-t bg-accent-400" style={{ height: `${Math.max(4, (d.captures / maxDay) * 100)}%` }} title={`${d.day}: ${d.captures} · ${usd(d.cost_usd)}`} />
                ))}
              </div>
            )}
            <h3 className="mt-4 mb-2 text-xs font-semibold text-muted">{t('admin.refusalReasons')}</h3>
            {Object.keys(usage.refusals_by_reason).length === 0 ? <p className="text-sm text-muted">{t('admin.noData')}</p> : (
              <ul className="flex flex-wrap gap-2">{Object.entries(usage.refusals_by_reason).map(([r, n]) => <li key={r}><Badge>{r}: {n}</Badge></li>)}</ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted">{t('admin.topUsers')}</h3>
            {usage.top_users.length === 0 ? <p className="text-sm text-muted">{t('admin.noData')}</p> : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">{t('admin.user')}</th><th>{t('admin.plan')}</th><th className="text-right">{t('admin.captures')}</th><th className="text-right">{t('admin.minutes')}</th><th className="text-right">{t('admin.cost')}</th></tr></thead>
                <tbody>{usage.top_users.map((u) => (
                  <tr key={u.user} className="border-t border-line"><td className="py-1.5 font-mono text-xs">{u.user}</td><td>{u.plan}</td><td className="text-right tabular-nums">{u.captures}</td><td className="text-right tabular-nums">{u.audio_minutes}</td><td className="text-right tabular-nums">{usd(u.cost_usd)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </div>
      </Card>

      <PlanLimitsEditor limits={usage.plan_limits} onSave={(l) => act(() => adminUpdatePlanLimits(l))} />

      <Card>
        <CardHeader title={t('admin.finance')} icon={<Coins className="size-4 text-accent-600" />} />
        <div className="px-5">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted"><Users className="size-3.5" />{t('admin.users')}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('admin.total')} value={finance.users.total} source="recorded" />
            <Stat label={t('admin.mau')} value={finance.users.monthly_active} source="recorded" />
            <Stat label={t('admin.free')} value={finance.users.free} source="recorded" />
            <Stat label={t('admin.premium')} value={`${finance.users.premium} (${finance.users.premium_monthly}/${finance.users.premium_annual})`} source="recorded" />
          </div>
          <table className="mt-5 w-full text-sm">
            <tbody>
              {([
                ['admin.revenueGross', finance.revenue_gross_eur, 'projected', finance.labels.revenue],
                ['admin.revenueNet', finance.revenue_net_eur, 'estimate', finance.labels.net_revenue],
                ['admin.stripeFees', -finance.stripe_fees_eur, 'estimate', finance.labels.stripe_fees],
                ['admin.aiCosts', -finance.ai_costs_eur, 'estimate', `${finance.labels.ai_costs} (${usd(finance.ai_costs_usd)})`],
                ['admin.opex', -finance.operating_expenses_eur, 'estimate', finance.labels.operating_expenses],
              ] as [TranslationKey, number, Source, string][]).map(([k, v, src, hint]) => (
                <tr key={k} className="border-t border-line align-top">
                  <td className="py-2"><div className="flex items-center gap-2">{t(k)} <SourceBadge source={src} /></div><div className="text-xs text-muted">{hint}</div></td>
                  <td className="py-2 text-right tabular-nums">{eur(v)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink/20">
                <td className="py-2 font-semibold"><div className="flex items-center gap-2">{t('admin.contribution')} <SourceBadge source="estimate" /></div><div className="text-xs font-normal text-muted">{t('admin.notProfit')}</div></td>
                <td className={cx('py-2 text-right text-lg font-semibold tabular-nums', finance.estimated_contribution_eur < 0 && 'text-red-700')}>{eur(finance.estimated_contribution_eur)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <FinanceAssumptions finance={finance} onSave={(p) => act(() => adminUpdateSettings(p))} />
        <Expenses finance={finance} month={monthStart(month)} onAdd={(e) => act(() => adminAddExpense(e))} onDelete={(id) => act(() => adminDeleteExpense(id))} />
      </Card>
    </div>
  );
}

function AiControls({ usage, onSave }: { usage: AdminUsageSummary; onSave: (p: Parameters<typeof adminUpdateSettings>[0]) => void }) {
  const { t } = useI18n();
  const s = usage.settings;
  const [mode, setMode] = useState(s.ai_mode);
  const [message, setMessage] = useState(s.ai_paused_message ?? '');
  const [daily, setDaily] = useState(String(s.daily_ai_budget_usd));
  const [monthly, setMonthly] = useState(String(s.monthly_ai_budget_usd));
  useEffect(() => { setMode(s.ai_mode); setMessage(s.ai_paused_message ?? ''); setDaily(String(s.daily_ai_budget_usd)); setMonthly(String(s.monthly_ai_budget_usd)); }, [s]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ ai_mode: mode, ai_paused_message: message, daily_budget: Number(daily), monthly_budget: Number(monthly) });
  };
  return (
    <Card>
      <CardHeader title={t('admin.aiControl')} icon={<Power className={cx('size-4', s.ai_mode === 'off' ? 'text-red-600' : 'text-accent-600')} />} />
      <div className="grid gap-5 px-5 pb-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Meter label={t('admin.spendToday')} value={usage.spend_today_usd} max={s.daily_ai_budget_usd} />
          <Meter label={t('admin.spendMonth')} value={usage.spend_month_usd} max={s.monthly_ai_budget_usd} />
          <p className="text-xs text-muted">{t('admin.spendNote')}</p>
          <p className="text-xs text-muted">{t('admin.outputCap')}: {s.max_output_tokens_per_call} · {t(s.disable_thinking ? 'admin.thinkingOff' : 'admin.thinkingOn')}</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label={t('admin.mode')}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              {(['admins_only', 'on', 'off'] as const).map((m) => <option key={m} value={m}>{t(`admin.mode.${m}` as TranslationKey)}</option>)}
            </Select>
          </Field>
          <Field label={t('admin.pausedMessage')}><Input value={message} maxLength={300} onChange={(e) => setMessage(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.dailyBudget')}><Input type="number" min={0} step="0.01" value={daily} onChange={(e) => setDaily(e.target.value)} required /></Field>
            <Field label={t('admin.monthlyBudget')}><Input type="number" min={0} step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)} required /></Field>
          </div>
          <div className="flex justify-end gap-2">
            {s.ai_mode !== 'off' && <Button type="button" variant="danger" onClick={() => onSave({ ai_mode: 'off' })} icon={<Power className="size-4" />}>{t('admin.mode.off')}</Button>}
            <Button type="submit">{t('admin.save')}</Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

function PlanLimitsEditor({ limits, onSave }: { limits: PlanLimits[]; onSave: (l: PlanLimits) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState(limits);
  useEffect(() => setRows(limits), [limits]);
  const fields: [keyof PlanLimits, TranslationKey][] = [
    ['ai_captures_per_month', 'admin.perMonth'], ['audio_minutes_per_month', 'admin.minutesPerMonth'],
    ['max_capture_seconds', 'admin.maxSeconds'], ['captures_per_hour', 'admin.perHour'], ['captures_per_day', 'admin.perDay'],
  ];
  return (
    <Card>
      <CardHeader title={t('admin.planLimits')} />
      <p className="px-5 text-xs text-muted">{t('admin.planLimitsNote')}</p>
      <div className="space-y-4 px-5 py-4">
        {rows.map((row, i) => (
          <form key={row.plan} onSubmit={(e) => { e.preventDefault(); onSave(row); }} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-7">
            <div className="col-span-2 sm:col-span-1"><Badge tone={row.plan === 'premium' ? 'accent' : 'neutral'}>{row.plan}</Badge></div>
            {fields.map(([f, label]) => (
              <Field key={f} label={t(label)}>
                <Input type="number" min={1} required value={row[f] as number}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, [f]: Number(e.target.value) } : r)))} />
              </Field>
            ))}
            <Button type="submit" variant="secondary">{t('admin.save')}</Button>
          </form>
        ))}
      </div>
    </Card>
  );
}

function FinanceAssumptions({ finance, onSave }: { finance: AdminFinanceSummary; onSave: (p: Parameters<typeof adminUpdateSettings>[0]) => void }) {
  const { t } = useI18n();
  const a = finance.assumptions;
  const [fx, setFx] = useState(String(a.fx_usd_to_eur));
  const [vat, setVat] = useState(String(a.vat_rate));
  const [incl, setIncl] = useState(a.prices_include_vat);
  useEffect(() => { setFx(String(a.fx_usd_to_eur)); setVat(String(a.vat_rate)); setIncl(a.prices_include_vat); }, [a]);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave({ fx_usd_to_eur: Number(fx), vat_rate: Number(vat), prices_include_vat: incl }); }}
      className="mx-5 mt-5 grid grid-cols-2 items-end gap-3 rounded-xl bg-canvas p-3 sm:grid-cols-4">
      <h3 className="col-span-2 text-xs font-semibold text-muted sm:col-span-4">{t('admin.assumptions')} · {finance.assumptions.price_monthly_eur} € / {finance.assumptions.price_annual_eur} € · Stripe {finance.assumptions.fee_region}</h3>
      <Field label={t('admin.fx')}><Input type="number" step="0.0001" min="0.0001" value={fx} onChange={(e) => setFx(e.target.value)} required /></Field>
      <Field label={t('admin.vat')}><Input type="number" step="0.0001" min="0" max="0.5" value={vat} onChange={(e) => setVat(e.target.value)} required /></Field>
      <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={incl} onChange={(e) => setIncl(e.target.checked)} className="accent-accent-600" />{t('admin.pricesIncludeVat')}</label>
      <Button type="submit" variant="secondary">{t('admin.save')}</Button>
    </form>
  );
}

function Expenses({ finance, month, onAdd, onDelete }: {
  finance: AdminFinanceSummary; month: string;
  onAdd: (e: { month: string; service: string; category: string; amount: number; currency: string; kind: string; note?: string }) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useI18n();
  const [service, setService] = useState('');
  const [category, setCategory] = useState('hosting');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [kind, setKind] = useState('estimate');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAdd({ month, service, category, amount: Number(amount), currency, kind });
    setService(''); setAmount('');
  };
  return (
    <div className="px-5 py-5">
      <h3 className="mb-2 text-xs font-semibold text-muted">{t('admin.expenses')}</h3>
      {finance.expenses.length === 0 ? <EmptyState text={t('admin.noData')} /> : (
        <ul className="mb-3 divide-y divide-line text-sm">
          {finance.expenses.map((x) => (
            <li key={x.id} className="flex items-center gap-3 py-2">
              <span className="flex-1">{x.service} <span className="text-xs text-muted">· {x.category}</span></span>
              <Badge tone={x.kind === 'actual' ? 'ok' : 'warn'}>{t(x.kind === 'actual' ? 'admin.actual' : 'admin.estimate')}</Badge>
              <span className="tabular-nums">{x.amount} {x.currency}</span>
              <button onClick={() => onDelete(x.id)} className="rounded p-1 text-muted hover:text-red-600" aria-label={t('common.delete')}><Trash2 className="size-4" /></button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-6">
        <Field label={t('admin.service')}><Input value={service} onChange={(e) => setService(e.target.value)} maxLength={80} required /></Field>
        <Field label={t('admin.category')}><Select value={category} onChange={(e) => setCategory(e.target.value)}>{['hosting', 'database', 'ai', 'payments', 'email', 'domain', 'other'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label={t('admin.amount')}><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label={t('admin.currency')}><Select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>EUR</option></Select></Field>
        <Field label={t('admin.kind')}><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="estimate">{t('admin.estimate')}</option><option value="actual">{t('admin.actual')}</option></Select></Field>
        <Button type="submit" variant="secondary">{t('admin.addExpense')}</Button>
      </form>
    </div>
  );
}
