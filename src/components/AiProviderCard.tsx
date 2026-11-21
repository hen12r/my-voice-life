import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, KeyRound } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, useI18n } from '../lib/i18n';
import { connectOpenAiKey, disconnectOpenAiKey, getAiConnections } from '../lib/api';
import type { AiConnection } from '../lib/types';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from './ui';

// "Your AI provider" (Bring Your Own AI). The key is typed once, sent to our Edge Function, which
// validates it with OpenAI and stores it encrypted (Supabase Vault). It is never shown again: the
// app only ever receives a 4-character hint. The input is cleared as soon as the request ends.
export function AiProviderCard() {
  const { t } = useI18n();
  const { usage, refreshUsage } = useAuth();
  const [conn, setConn] = useState<AiConnection | null | undefined>(undefined);
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    getAiConnections().then((c) => setConn(c.find((x) => x.provider === 'openai') ?? null)).catch(() => setConn(null));
  }, []);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await connectOpenAiKey(key);
      setConn({ provider: 'openai', hint: r.hint, status: 'active', validated_at: new Date().toISOString() });
      setEditing(false);
      setMsg({ kind: 'success', text: t('ai.connected') });
      void refreshUsage();
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(t, err) });
    } finally {
      setKey(''); // never keep the key in memory longer than the request
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm(t('ai.confirmDisconnect'))) return;
    setBusy(true); setMsg(null);
    try { await disconnectOpenAiKey(); setConn(null); void refreshUsage(); setMsg({ kind: 'success', text: t('ai.disconnected') }); }
    catch (err) { setMsg({ kind: 'error', text: errorMessage(t, err) }); }
    finally { setBusy(false); }
  };

  const showForm = conn === null || editing;
  return (
    <Card>
      <CardHeader title={t('ai.title')} icon={<KeyRound className="size-4 text-accent-600" />} />
      <div id="ai" className="space-y-4 px-5 pb-5 text-sm">
        <p className="text-muted">{t('ai.intro')}</p>
        {usage && usage.byoai_allowed === false && <Alert kind="info">{t('ai.notOpenYet')}</Alert>}
        {conn && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{t('ai.keyConnected').replace('{hint}', conn.hint)}</span>
            <Badge tone={conn.status === 'active' ? 'ok' : 'danger'}>{t(conn.status === 'active' ? 'ai.statusActive' : 'ai.statusInvalid')}</Badge>
          </div>
        )}
        {conn?.status === 'invalid' && <Alert>{t('errors.ai_key_invalid')}</Alert>}
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {showForm ? (
          <form onSubmit={connect} className="space-y-3" autoComplete="off">
            <Field label={t('ai.keyLabel')} hint={t('ai.keyHint')}>
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-…" autoComplete="off" spellCheck={false}
                autoCapitalize="none" autoCorrect="off" maxLength={400} required />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={key.trim().length < 20}>{t('ai.connect')}</Button>
              {editing && <Button type="button" variant="ghost" onClick={() => { setEditing(false); setKey(''); }}>{t('common.cancel')}</Button>}
            </div>
          </form>
        ) : conn && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => { setEditing(true); setMsg(null); }}>{t('ai.replace')}</Button>
            <Button variant="ghost" className="text-red-700" loading={busy} onClick={disconnect}>{t('ai.disconnect')}</Button>
          </div>
        )}
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
          <li>{t('ai.point.billing')}</li>
          <li>{t('ai.point.storage')}</li>
          <li>{t('ai.point.privacy')}</li>
        </ul>
        <p className="flex flex-wrap gap-4 text-xs">
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-700 hover:underline">{t('ai.getKey')}<ExternalLink className="size-3" aria-hidden /></a>
          <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-700 hover:underline">{t('ai.openaiBilling')}<ExternalLink className="size-3" aria-hidden /></a>
        </p>
      </div>
    </Card>
  );
}
