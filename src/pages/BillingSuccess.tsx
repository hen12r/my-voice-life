import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Clock } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../lib/i18n';
import { getMyUsage } from '../lib/api';
import { Button, Card, Spinner } from '../components/ui';

const POLL_MS = 2000;
const GIVE_UP_MS = 30_000;

/**
 * Stripe sends the user here after Checkout. The URL (including session_id) proves NOTHING and is
 * ignored: this page only asks our server whether the verified webhook has switched Premium on.
 */
export default function BillingSuccess() {
  const { t } = useI18n();
  const { refreshUsage, usage } = useAuth();
  const [state, setState] = useState<'checking' | 'active' | 'slow'>('checking');
  const started = useRef(Date.now());

  const check = useCallback(async () => {
    // Server-computed plan (effective_plan in the database) — the only source of truth.
    const u = await getMyUsage();
    if (u?.plan === 'premium') { void refreshUsage(); return true; }
    return false;
  }, [refreshUsage]);

  useEffect(() => {
    if (state !== 'checking') return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (await check().catch(() => false)) { setState('active'); return; }
      if (Date.now() - started.current > GIVE_UP_MS) { setState('slow'); return; }
      setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { cancelled = true; };
  }, [state, check]);

  useEffect(() => { if (usage?.plan === 'premium') setState('active'); }, [usage?.plan]);

  return (
    <div className="mx-auto max-w-md pt-6">
      <Card className="animate-card-in p-6 text-center" >
        {state === 'checking' && (
          <div aria-live="polite">
            <Spinner />
            <h1 className="mt-2 text-lg font-semibold text-ink">{t('billing.confirming')}</h1>
            <p className="mt-2 text-sm text-muted">{t('billing.confirmingHint')}</p>
          </div>
        )}
        {state === 'active' && (
          <div aria-live="polite">
            <CheckCircle2 className="animate-pop mx-auto size-10 text-accent-600" aria-hidden />
            <h1 className="mt-3 text-lg font-semibold text-ink">{t('billing.active')}</h1>
            <Link to="/app" className="mt-5 inline-block"><Button>{t('pricing.backToApp')}</Button></Link>
          </div>
        )}
        {state === 'slow' && (
          <div aria-live="polite">
            <Clock className="mx-auto size-10 text-muted" aria-hidden />
            <p className="mt-3 text-sm text-ink">{t('billing.slow')}</p>
            <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => { started.current = Date.now(); setState('checking'); }}>{t('billing.checkAgain')}</Button>
              <Link to="/app"><Button className="w-full">{t('pricing.backToApp')}</Button></Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
