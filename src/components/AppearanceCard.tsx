import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { getThemePref, setThemePref, THEME_PREFS, type ThemePref } from '../lib/theme';
import { Card, CardHeader, cx } from './ui';

const ICONS: Record<ThemePref, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

// Light / dark / same as device. A per-device preference (localStorage), applied immediately.
export function AppearanceCard() {
  const { t } = useI18n();
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  return (
    <Card>
      <CardHeader title={t('settings.appearance')} />
      <div className="space-y-2 px-5 pb-5">
        <div role="radiogroup" aria-label={t('settings.appearance')} className="grid grid-cols-3 gap-2">
          {THEME_PREFS.map((p) => {
            const Icon = ICONS[p];
            const on = pref === p;
            return (
              <button key={p} type="button" role="radio" aria-checked={on} onClick={() => { setThemePref(p); setPref(p); }}
                className={cx('flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors',
                  on ? 'border-accent-500 bg-accent-50 text-accent-700' : 'border-line bg-surface text-muted hover:text-ink')}>
                <Icon className="size-5" aria-hidden />
                {t(`settings.theme.${p}` as TranslationKey)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted">{t('settings.themeHint')}</p>
      </div>
    </Card>
  );
}
