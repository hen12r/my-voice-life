import { RefreshCw, WifiOff } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { applyUpdate, usePwa } from './pwa';

/** App-wide: offline notice and "new version ready" prompt. Both are honest and never block the page. */
export function PwaBanners() {
  const { t } = useI18n();
  const { online, updateReady } = usePwa();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-2 px-3" aria-live="polite">
      {!online && (
        <div role="status" className="pointer-events-auto flex items-center gap-2 rounded-xl bg-navy-900 px-4 py-2 text-sm text-white shadow-lg">
          <WifiOff className="size-4 shrink-0" aria-hidden />{t('pwa.offline')}
        </div>
      )}
      {updateReady && (
        <div role="status" className="pointer-events-auto flex items-center gap-3 rounded-xl bg-white px-4 py-2 text-sm text-ink shadow-lg ring-1 ring-line">
          <span>{t('pwa.updateReady')}</span>
          <button type="button" onClick={applyUpdate} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 font-medium text-white hover:bg-accent-700">
            <RefreshCw className="size-3.5" aria-hidden />{t('pwa.reload')}
          </button>
        </div>
      )}
    </div>
  );
}
