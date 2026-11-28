import { useEffect, useState } from 'react';
import { Bell, BellOff, Send } from 'lucide-react';
import { errorMessage, useI18n, type TranslationKey } from '../lib/i18n';
import { getPushPublicKey, sendTestPush } from '../lib/api';
import { currentSubscription, detectPushSupport, disablePush, enablePush, PushPermissionError, type PushSupport } from './push';
import { Alert, Button, Card, CardHeader } from '../components/ui';

type State = 'loading' | 'unavailable' | Exclude<PushSupport, 'ok'> | 'off' | 'on';
const INFO: Partial<Record<State, TranslationKey>> = {
  unavailable: 'push.unavailable', unsupported: 'push.unsupported', 'ios-install': 'push.iosInstall', denied: 'push.denied',
};

// Settings → "Reminder notifications". Every state is real: no button is shown unless it can work.
export function NotificationsCard() {
  const { t } = useI18n();
  const [state, setState] = useState<State>('loading');
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    const support = detectPushSupport();
    if (support !== 'ok') { setState(support); return; }
    (async () => {
      try { setKey(await getPushPublicKey()); }
      catch {
        // Function not deployed (404), keys not set (503 push_not_configured) or unreachable:
        // the server part isn't available, so no button is offered.
        setState('unavailable'); return;
      }
      setState((await currentSubscription().catch(() => null)) ? 'on' : 'off');
    })();
  }, []);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setMsg(null);
    try { await fn(); }
    catch (e) {
      if (e instanceof PushPermissionError) setState('denied');
      else setMsg({ kind: 'error', text: errorMessage(t, e) });
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader title={t('push.title')} icon={<Bell className="size-4 text-accent-600" />} />
      <div className="space-y-3 px-5 pb-5 text-sm">
        <p className="text-muted">{t('push.intro')}</p>
        {INFO[state] && <Alert kind="info">{t(INFO[state]!)}</Alert>}
        {state === 'on' && <Alert kind="success">{t('push.on')}</Alert>}
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {state === 'off' && (
          <Button loading={busy === 'enable'} icon={<Bell className="size-4" />}
            onClick={() => run('enable', async () => { await enablePush(key ?? undefined); setState('on'); })}>{t('push.enable')}</Button>
        )}
        {state === 'on' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy === 'test'} disabled={busy !== null} icon={<Send className="size-4" />}
              onClick={() => run('test', async () => { await sendTestPush(t('push.title'), t('push.testBody')); setMsg({ kind: 'success', text: t('push.testSent') }); })}>{t('push.test')}</Button>
            <Button variant="ghost" loading={busy === 'disable'} disabled={busy !== null} icon={<BellOff className="size-4" />}
              onClick={() => run('disable', async () => { await disablePush(); setState('off'); })}>{t('push.disable')}</Button>
          </div>
        )}
        {(state === 'on' || state === 'off') && <p className="text-xs text-muted">{t('push.privacy')}</p>}
      </div>
    </Card>
  );
}
