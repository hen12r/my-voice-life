import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';
import { errorMessage, useI18n } from '../lib/i18n';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { Logo } from '../components/AppShell';

/** Google sign-in through Supabase Auth. A verified Google email that matches an existing
 *  account is linked to it by Supabase (no duplicate account). */
function GoogleButton({ onError }: { onError: (msg: string) => void }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const go = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/app` } });
    // On success the browser navigates away to Google; we only get here on an error.
    setLoading(false);
    if (error) onError(/not enabled|unsupported provider/i.test(error.message) ? t('auth.googleUnavailable') : errorMessage(t, error));
  };
  return (
    <>
      <Button type="button" variant="secondary" loading={loading} onClick={go} className="w-full" icon={<GoogleMark />}>{t('auth.google')}</Button>
      <div className="my-4 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />{t('auth.or')}<span className="h-px flex-1 bg-line" /></div>
    </>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

function AuthLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <Link to="/" className="mb-8"><Logo /></Link>
      <Card className="w-full max-w-sm p-6 shadow-sm">
        <h1 className="mb-5 text-lg font-semibold">{title}</h1>
        {children}
      </Card>
      {footer && <div className="mt-5 text-sm text-muted">{footer}</div>}
    </div>
  );
}

export function Login() {
  const { t } = useI18n();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (session) return <Navigate to="/app" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setError(errorMessage(t, error)); else navigate('/app');
  };

  return (
    <AuthLayout title={t('auth.login')} footer={<Link className="text-accent-700 hover:underline" to="/register">{t('auth.noAccount')}</Link>}>
      <GoogleButton onError={setError} />
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('auth.email')}><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('auth.password')}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={loading} className="w-full">{t('auth.login')}</Button>
        <Link to="/forgot-password" className="block text-center text-sm text-muted hover:text-ink">{t('auth.forgot')}</Link>
      </form>
    </AuthLayout>
  );
}

export function Register() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  if (session) return <Navigate to="/app" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError(t('auth.passwordHint')); return; }
    setLoading(true); setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { emailRedirectTo: `${window.location.origin}/app` },
    });
    if (!error && data.user && name.trim() && data.session) {
      await supabase.from('profiles').update({ display_name: name.trim().slice(0, 80) }).eq('id', data.user.id);
    }
    setLoading(false);
    if (error) setError(errorMessage(t, error));
    else if (!data.session) setDone(true); // email confirmation required
  };

  return (
    <AuthLayout title={t('auth.register')} footer={<Link className="text-accent-700 hover:underline" to="/login">{t('auth.haveAccount')}</Link>}>
      {done ? <Alert kind="success">{t('auth.checkEmail')}</Alert> : (<>
        <GoogleButton onError={setError} />
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('auth.name')}><Input autoComplete="name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('auth.email')}><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('auth.password')} hint={t('auth.passwordHint')}><Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={loading} className="w-full">{t('auth.register')}</Button>
        </form>
      </>)}
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` });
    setLoading(false);
    if (error) setError(errorMessage(t, error)); else setSent(true);
  };
  return (
    <AuthLayout title={t('auth.resetTitle')} footer={<Link className="text-accent-700 hover:underline" to="/login">{t('auth.login')}</Link>}>
      {sent ? <Alert kind="success">{t('auth.resetSent')}</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('auth.email')}><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={loading} className="w-full">{t('auth.resetSend')}</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const { t } = useI18n();
  const { session } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError(t('auth.passwordHint')); return; }
    setLoading(true); setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) setError(errorMessage(t, error)); else navigate('/app');
  };
  return (
    <AuthLayout title={t('auth.updatePassword')}>
      {!session ? <Alert>{t('errors.unauthorized')}</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')}><Input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" loading={loading} className="w-full">{t('auth.updatePassword')}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
