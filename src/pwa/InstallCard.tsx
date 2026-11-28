import { useState } from 'react';
import { Download, MonitorSmartphone, Share } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { promptInstall, usePwa } from './pwa';
import { Button, Card, CardHeader } from '../components/ui';

/** Settings card. Shows a real install button only when the browser offers one (no dead button);
 *  on iPhone/iPad Safari, the manual steps; when already installed, says so. Otherwise hidden. */
export function InstallCard() {
  const { t } = useI18n();
  const { canInstall, standalone, iosSafari } = usePwa();
  const [busy, setBusy] = useState(false);
  if (!canInstall && !standalone && !iosSafari) return null;
  return (
    <Card>
      <CardHeader title={t('pwa.installTitle')} icon={<MonitorSmartphone className="size-4 text-accent-600" />} />
      <div className="space-y-3 px-5 pb-5 text-sm">
        {standalone ? <p className="text-muted">{t('pwa.installed')}</p> : canInstall ? (
          <>
            <p className="text-muted">{t('pwa.installHint')}</p>
            <Button loading={busy} icon={<Download className="size-4" />} onClick={async () => { setBusy(true); await promptInstall().catch(() => false); setBusy(false); }}>
              {t('pwa.install')}
            </Button>
          </>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li className="flex-wrap">{t('pwa.iosStep1')} <Share className="inline size-4 align-text-bottom" aria-label={t('pwa.share')} /></li>
            <li>{t('pwa.iosStep2')}</li>
            <li>{t('pwa.iosStep3')}</li>
          </ol>
        )}
      </div>
    </Card>
  );
}
