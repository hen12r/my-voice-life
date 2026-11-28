import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useI18n } from '../lib/i18n';
import { Logo } from '../components/AppShell';

// DRAFT legal texts. They describe only what the code actually does (checked against the
// repository on 2026-11-21). They contain NO invented legal identity, address or certification:
// the owner must complete the bracketed items and have the texts reviewed before a public launch.
// English only for now; a reviewed French version is still needed.

const UPDATED = '28 November 2026';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const { session } = useAuth();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="bg-navy-950 text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <Link to={session ? '/app' : '/'} aria-label="My Voice Life"><Logo light /></Link>
          <Link to={session ? '/app/settings' : '/'} className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white">
            <ArrowLeft className="size-4" />{t('legal.back')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-8">
        <div role="note" className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{t('legal.draftNotice')}</div>
        <article className="legal space-y-4 text-sm leading-relaxed text-ink [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-xs text-muted">Last updated: {UPDATED}</p>
          {children}
        </article>
      </main>
    </div>
  );
}

const Todo = ({ children }: { children: ReactNode }) => <mark className="rounded bg-amber-100 px-1 text-amber-900">[{children}]</mark>;

export function PrivacyPolicy() {
  return (
    <Shell title="Privacy policy (draft)">
      <p>My Voice Life turns what you say into notes, tasks, reminders and events that you review before saving. This page explains what data that involves.</p>
      <p>Who is responsible: <Todo>name of the person or organisation responsible, and their country — to be completed by the owner</Todo>. Contact: <Todo>contact email address — to be completed by the owner</Todo>.</p>

      <h2>What we store</h2>
      <ul>
        <li><b>Account:</b> your email address, and your password in hashed form (we never see it). If you use Google sign-in: your Google email and basic profile information sent by Google.</li>
        <li><b>Profile and preferences:</b> display name, interface language, spoken languages, time zone.</li>
        <li><b>Your content:</b> notes, tasks, reminders, events, categories, and the text transcripts of your voice captures.</li>
        <li><b>Usage records:</b> for each AI capture, the date, duration, token counts and estimated cost (no content). These enforce plan limits and spending caps.</li>
        <li><b>Billing (only if you subscribe):</b> a Stripe customer and subscription identifier and status. Card details are entered on Stripe's pages; we never receive them.</li>
      </ul>

      <h2>Voice recordings</h2>
      <ul>
        <li>Recording starts only when you press the microphone, and the browser asks your permission first.</li>
        <li><b>We do not store your audio.</b> It is processed in memory by our server function and discarded.</li>
        <li>To transcribe and organise it, the audio and then the transcript text are sent to <b>OpenAI</b>: either through My Voice Life's own OpenAI account (within your plan's included allowance), or, if you connected one, through <b>your own OpenAI API key</b> (see "Your AI key" below), in which case OpenAI processes them under your OpenAI account and its terms. We send requests with storage turned off where OpenAI offers that option; OpenAI's own data policies apply to the processing it performs.</li>
        <li>The text transcript is saved with your records, because it is your searchable memory. You can delete it.</li>
        <li>Nothing the AI suggests is saved until you review and accept it.</li>
      </ul>

      <h2>Who processes data for us</h2>
      <ul>
        <li><b>Supabase</b> — database, sign-in and server functions.</li>
        <li><b>Vercel</b> — hosting of the web app.</li>
        <li><b>OpenAI</b>: speech-to-text and organising your words, only when you use voice or "Organise" (through our account, or yours if you connected a key).</li>
        <li><b>Stripe</b> — payments, only if you subscribe.</li>
        <li><b>Google</b> — only if you choose "Continue with Google".</li>
      </ul>
      <p>Server locations and international transfers: <Todo>to be completed by the owner from the chosen Supabase, Vercel and OpenAI regions and contracts</Todo>.</p>

      <h2>Your AI key</h2>
      <ul>
        <li>If you connect an OpenAI API key, we check it with OpenAI and store it <b>encrypted</b> (Supabase Vault). It is used only by our server to process your own recordings, and it is never shown again in the app (only its last 4 characters).</li>
        <li>When your own key is used, OpenAI bills your OpenAI account for that usage. Usage within your plan's included allowance is paid by My Voice Life.</li>
        <li>Disconnecting the key, or deleting your account, deletes it.</li>
      </ul>

      <h2>Cookies and local storage</h2>
      <p>We use no advertising or analytics cookies and no trackers. Your browser's local storage keeps your sign-in session and one preference (sound cues). These are necessary for the app to work.</p>

      <h2>How long we keep data</h2>
      <ul>
        <li>Your account and content: until you delete them or your account.</li>
        <li><b>Deleting your account</b> (Settings → Delete my account) permanently removes your profile, notes, tasks, reminders, events, transcripts and preferences. An active subscription is cancelled first.</li>
        <li>Usage and payment-event records are kept without any link to you after deletion, for cost and accounting purposes.</li>
      </ul>

      <h2>Your rights</h2>
      <p>You can view, edit and delete your content in the app at any time, download a copy of all of it yourself (Settings → Your data → Download all my data, a JSON file), and delete your account yourself. For any other request, contact us at the address above. <Todo>add the applicable data-protection authority and legal basis after review</Todo></p>

      <h2>Children</h2>
      <p><Todo>minimum age and parental-consent rules — to be decided by the owner with advice</Todo></p>
    </Shell>
  );
}

export function TermsOfService() {
  return (
    <Shell title="Terms of service (draft)">
      <p>These terms apply to My Voice Life, provided by <Todo>name of the person or organisation — to be completed by the owner</Todo>.</p>

      <h2>The service</h2>
      <ul>
        <li>My Voice Life helps you organise your thoughts into notes, tasks, reminders and events.</li>
        <li>AI suggestions can be wrong: <b>you review every item before it is saved</b>. Do not rely on the app for medical, legal, safety-critical or emergency reminders.</li>
        <li>Voice recognition quality has not yet been verified for any language.</li>
      </ul>

      <h2>Your account</h2>
      <ul>
        <li>Keep your password private. You are responsible for activity on your account.</li>
        <li>Your content remains yours. We use it only to provide the service to you.</li>
        <li>Do not misuse the service (for example, attempts to access other people's data or to overload it).</li>
      </ul>

      <h2>Plans and payment</h2>
      <ul>
        <li>Plans: Free, Plus and Pro. Their limits (for example the number of active reminders, upcoming events, and voice captures per day) are shown on the Pricing page. Notes and tasks you type are unlimited on every plan.</li>
        <li>Each plan includes a monthly AI allowance (voice captures and minutes of audio), shown on the Pricing page. You may also connect your own OpenAI API key; OpenAI then bills you directly for that usage under its own terms.</li>
        <li>Plus and Pro are subscriptions, billed monthly or yearly at the price shown on the Pricing page when you subscribe, renewing automatically until you cancel. You can switch plan or billing period; Stripe calculates any proration.</li>
        <li>You can cancel at any time from the Billing page; your plan then stays active until the end of the paid period. If a payment fails, the plan is kept for a short grace period while the payment is retried.</li>
        <li>Refunds and withdrawal rights: <Todo>to be completed by the owner in line with the law of the countries where plans are sold</Todo>.</li>
        <li>Taxes: <Todo>VAT/tax handling to be decided before live payments</Todo>.</li>
      </ul>

      <h2>Availability and changes</h2>
      <p>The service is provided as it is, without a guarantee of uninterrupted availability. We may change these terms; significant changes will be announced in the app.</p>

      <h2>Contact and applicable law</h2>
      <p><Todo>contact address, governing law and competent courts — to be completed after legal review</Todo></p>
    </Shell>
  );
}
