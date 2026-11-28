import { useState } from 'react';
import { Download } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { downloadJson, exportAllData } from '../lib/export';
import { Alert, Button, Card, CardHeader } from './ui';

// Settings → "Your data". Reads everything the user owns with their own session and saves one
// JSON file locally. If any part fails, no file is saved (never a partial export shown as complete).
export function ExportCard() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const run = async () => {
    if (!session) return;
    setBusy(true); setMsg(null);
    try {
      const file = await exportAllData(session.user.id);
      downloadJson(file);
      const c = file.counts;
      setMsg({ kind: 'success', text: t('export.done').replace('{notes}', String(c.notes)).replace('{tasks}', String(c.tasks))
        .replace('{reminders}', String(c.reminders)).replace('{events}', String(c.events)).replace('{sessions}', String(c.voice_sessions)) });
    } catch (e) {
      setMsg({ kind: 'error', text: `${t('export.failed')} (${errorMessage(t, e)})` });
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader title={t('export.title')} icon={<Download className="size-4 text-accent-600" />} />
      <div className="space-y-3 px-5 pb-5 text-sm">
        <p className="text-muted">{t('export.body')}</p>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <Button variant="secondary" loading={busy} onClick={run} icon={<Download className="size-4" />}>{t('export.button')}</Button>
      </div>
    </Card>
  );
}
