import { functionsUrl, supabase } from './supabase';
import type { ProposedItem } from '../../supabase/functions/_shared/extraction.ts';
import type { AdminFinanceSummary, AdminUsageSummary, BillingInfo, CalendarEvent, Category, MemoryHit, MyUsage, Note, PlanLimits, Profile, Reminder, Subscription, Task } from './types';
import { zonedTimeToUtc } from './dates';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); }
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): NonNullable<T> {
  if (res.error) throw new ApiError(res.error.code ?? 'db_error', res.error.message);
  return res.data as NonNullable<T>;
}

function checkMaybe<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T | null {
  if (res.error) throw new ApiError(res.error.code ?? 'db_error', res.error.message);
  return res.data;
}

// ---------------- Profile & settings ----------------
export const getProfile = async (): Promise<Profile> =>
  check(await supabase.from('profiles').select('id, display_name, ui_language, speech_language, speech_languages, timezone, daily_briefing_enabled').single());

export const updateProfile = async (id: string, patch: Partial<Omit<Profile, 'id'>>) =>
  check(await supabase.from('profiles').update(patch).eq('id', id).select().single());

export const getSubscription = async (): Promise<Subscription | null> => {
  let res = await supabase.from('subscriptions')
    .select('plan, status, billing_interval, current_period_end, cancel_at_period_end, stripe_customer_id').maybeSingle();
  // Before the billing migration is applied the new column doesn't exist yet: fall back.
  if (res.error?.code === '42703') res = await supabase.from('subscriptions').select('plan, status, billing_interval, current_period_end, stripe_customer_id').maybeSingle();
  const row = checkMaybe(res) as (Partial<Subscription> & { stripe_customer_id: string | null }) | null;
  if (!row) return null;
  const { stripe_customer_id, ...rest } = row;
  return { ...(rest as Subscription), cancel_at_period_end: rest.cancel_at_period_end ?? false, has_billing_account: Boolean(stripe_customer_id) };
};

/** The caller's own AI allowance, counted on the server (never in the browser). */
export const getMyUsage = async (): Promise<MyUsage | null> => checkMaybe(await supabase.rpc('mvl_my_usage')) as MyUsage | null;

/** Marks the user active today (one row per day) for honest monthly-active-user counts. */
export const touchActivity = async (): Promise<void> => { await supabase.rpc('mvl_touch_activity'); };

// ---------------- Admin (every RPC re-checks mvl_is_admin() on the server) ----------------
export const getAdminUsage = async (month?: string): Promise<AdminUsageSummary> =>
  check(await supabase.rpc('mvl_admin_usage_summary', { p_month: month ?? null })) as AdminUsageSummary;
export const getAdminFinance = async (month?: string): Promise<AdminFinanceSummary> =>
  check(await supabase.rpc('mvl_admin_finance_summary', { p_month: month ?? null })) as AdminFinanceSummary;
export const adminUpdateSettings = async (p: {
  ai_mode?: string; ai_paused_message?: string; daily_budget?: number; monthly_budget?: number;
  fx_usd_to_eur?: number; vat_rate?: number; prices_include_vat?: boolean;
}) => checkMaybe(await supabase.rpc('mvl_admin_update_settings', {
  p_ai_mode: p.ai_mode ?? null, p_ai_paused_message: p.ai_paused_message ?? null,
  p_daily_budget: p.daily_budget ?? null, p_monthly_budget: p.monthly_budget ?? null,
  p_fx_usd_to_eur: p.fx_usd_to_eur ?? null, p_vat_rate: p.vat_rate ?? null, p_prices_include_vat: p.prices_include_vat ?? null,
}));
export const adminUpdatePlanLimits = async (l: PlanLimits) => checkMaybe(await supabase.rpc('mvl_admin_update_plan_limits', {
  p_plan: l.plan, p_captures: l.ai_captures_per_month, p_minutes: l.audio_minutes_per_month,
  p_max_seconds: l.max_capture_seconds, p_per_hour: l.captures_per_hour, p_per_day: l.captures_per_day,
}));
export const adminAddExpense = async (e: { month: string; service: string; category: string; amount: number; currency: string; kind: string; note?: string }) =>
  checkMaybe(await supabase.rpc('mvl_admin_add_expense', {
    p_month: e.month, p_service: e.service, p_category: e.category, p_amount: e.amount, p_currency: e.currency, p_kind: e.kind, p_note: e.note ?? null,
  }));
export const adminDeleteExpense = async (id: number) => checkMaybe(await supabase.rpc('mvl_admin_delete_expense', { p_id: id }));
export const adminAckAlert = async (id: number) => checkMaybe(await supabase.rpc('mvl_admin_ack_alert', { p_id: id }));

// ---------------- Categories ----------------
export const listCategories = async (): Promise<Category[]> =>
  check(await supabase.from('categories').select('id, name, color, is_default').order('is_default', { ascending: false }).order('name'));
export const createCategory = async (name: string) =>
  check(await supabase.from('categories').insert({ name: name.trim() }).select().single());
export const deleteCategory = async (id: string) => check(await supabase.from('categories').delete().eq('id', id));

// ---------------- Notes ----------------
const NOTE_COLS = 'id, title, body, kind, category_id, language, is_pinned, voice_session_id, created_at, updated_at';
export const listNotes = async (limit = 200): Promise<Note[]> =>
  check(await supabase.from('notes').select(NOTE_COLS).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }).limit(limit));
export const createNote = async (n: Partial<Note> & { body: string }) => check(await supabase.from('notes').insert(n).select(NOTE_COLS).single()) as Note;
export const updateNote = async (id: string, patch: Partial<Note>) => check(await supabase.from('notes').update(patch).eq('id', id).select(NOTE_COLS).single()) as Note;
export const deleteNote = async (id: string) => check(await supabase.from('notes').delete().eq('id', id));

// ---------------- Tasks ----------------
const TASK_COLS = 'id, title, details, status, priority, due_date, due_at, completed_at, category_id, created_at';
export const listTasks = async (): Promise<Task[]> =>
  check(await supabase.from('tasks').select(TASK_COLS).order('status').order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(500));
export const createTask = async (t: Partial<Task> & { title: string }) => check(await supabase.from('tasks').insert(t).select(TASK_COLS).single()) as Task;
export const updateTask = async (id: string, patch: Partial<Task>) => check(await supabase.from('tasks').update(patch).eq('id', id).select(TASK_COLS).single()) as Task;
export const deleteTask = async (id: string) => check(await supabase.from('tasks').delete().eq('id', id));

// ---------------- Reminders ----------------
const REM_COLS = 'id, title, notes, remind_at, timezone, recurrence, status, category_id, created_at';
export const listReminders = async (): Promise<Reminder[]> =>
  check(await supabase.from('reminders').select(REM_COLS).order('remind_at').limit(500));
export const createReminder = async (r: Partial<Reminder> & { title: string; remind_at: string; timezone: string }) =>
  check(await supabase.from('reminders').insert(r).select(REM_COLS).single()) as Reminder;
export const updateReminder = async (id: string, patch: Partial<Reminder>) =>
  check(await supabase.from('reminders').update(patch).eq('id', id).select(REM_COLS).single()) as Reminder;
export const deleteReminder = async (id: string) => check(await supabase.from('reminders').delete().eq('id', id));

// ---------------- Events ----------------
const EV_COLS = 'id, title, notes, location, starts_at, ends_at, all_day, category_id, created_at';
export const listEvents = async (): Promise<CalendarEvent[]> =>
  check(await supabase.from('events').select(EV_COLS).order('starts_at').limit(500));
export const createEvent = async (e: Partial<CalendarEvent> & { title: string; starts_at: string }) =>
  check(await supabase.from('events').insert(e).select(EV_COLS).single()) as CalendarEvent;
export const updateEvent = async (id: string, patch: Partial<CalendarEvent>) =>
  check(await supabase.from('events').update(patch).eq('id', id).select(EV_COLS).single()) as CalendarEvent;
export const deleteEvent = async (id: string) => check(await supabase.from('events').delete().eq('id', id));

// ---------------- Memory ----------------
export const searchMemory = async (q: string): Promise<MemoryHit[]> =>
  check(await supabase.rpc('search_memory', { q, max_results: 40 }));

// ---------------- Edge Functions ----------------
export interface ProcessResult {
  session_id: string;
  transcript: string;
  language: string;
  today: string;
  timezone: string;
  items: ProposedItem[];
  warnings: string[];
  usage?: { plan: string; captures_used: number; captures_limit: number; minutes_used: number; minutes_limit: number };
}

async function callFunction<T>(name: string, body: BodyInit, json: boolean): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('unauthorized', 'Not signed in', 401);
  let res: Response;
  try {
    res = await fetch(`${functionsUrl}/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
  } catch {
    throw new ApiError('network', 'Network error');
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(payload?.error?.code ?? `http_${res.status}`, payload?.error?.message ?? `Request failed (${res.status})`, res.status);
  }
  return payload as T;
}

/**
 * Sends a recording for transcription + organising. `languages` = the user's spoken languages
 * (hints). Uses XMLHttpRequest so the UI can show REAL upload progress; `onUploaded` fires when
 * the last byte has been sent (from then on the server is transcribing and organising).
 */
export async function processAudio(blob: Blob, durationMs: number, timezone: string, languages: string[],
  progress?: { onUpload?: (fraction: number) => void; onUploaded?: () => void }): Promise<ProcessResult> {
  const form = new FormData();
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  form.append('audio', blob, `capture.${ext}`);
  form.append('duration_ms', String(Math.round(durationMs)));
  form.append('timezone', timezone);
  form.append('languages', JSON.stringify(languages));
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('unauthorized', 'Not signed in', 401);
  return new Promise<ProcessResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${functionsUrl}/process-voice`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress?.onUpload?.(e.loaded / e.total); };
    xhr.upload.onload = () => progress?.onUploaded?.();
    xhr.onerror = () => reject(new ApiError('network', 'Network error'));
    xhr.ontimeout = () => reject(new ApiError('ai_timeout', 'Request timed out'));
    xhr.timeout = 180_000;
    xhr.onload = () => {
      let payload: { error?: { code?: string; message?: string } } | null = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload) resolve(payload as unknown as ProcessResult);
      else reject(new ApiError(payload?.error?.code ?? `http_${xhr.status}`, payload?.error?.message ?? `Request failed (${xhr.status})`, xhr.status));
    };
    xhr.send(form);
  });
}

export function processText(text: string, timezone: string, languages: string[]) {
  return callFunction<ProcessResult>('process-voice', JSON.stringify({ text, timezone, languages }), true);
}

// ---------------- Billing (Stripe). The browser only ever receives Stripe-hosted URLs; Premium is
// granted exclusively by the verified webhook on the server, never by anything the browser reports.
export async function getBillingInfo(): Promise<BillingInfo> {
  let res: Response;
  try {
    res = await fetch(`${functionsUrl}/billing`, {
      method: 'POST',
      headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'prices' }),
    });
  } catch {
    throw new ApiError('network', 'Network error');
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload) throw new ApiError(payload?.error?.code ?? `http_${res.status}`, payload?.error?.message ?? 'Request failed', res.status);
  return payload as BillingInfo;
}

/** Only Stripe's own hosted pages are followed. */
export function isStripeHostedUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname === 'billing.stripe.com');
  } catch { return false; }
}

async function billingRedirect(body: Record<string, unknown>): Promise<string> {
  const { url } = await callFunction<{ url: unknown }>('billing', JSON.stringify(body), true);
  if (!isStripeHostedUrl(url)) throw new ApiError('billing_failed', 'Unexpected redirect');
  return url;
}
export const startCheckout = (interval: 'month' | 'year') => billingRedirect({ action: 'checkout', interval });
export const openBillingPortal = () => billingRedirect({ action: 'portal' });

export function deleteAccount() {
  return callFunction<{ deleted: boolean }>('delete-account', JSON.stringify({ confirm: 'DELETE' }), true);
}

// ---------------- Committing reviewed proposals ----------------
export interface ReviewedItem extends ProposedItem { include: boolean }

export type InsertPlan =
  | { table: 'notes'; row: Record<string, unknown> }
  | { table: 'tasks'; row: Record<string, unknown> }
  | { table: 'reminders'; row: Record<string, unknown> }
  | { table: 'events'; row: Record<string, unknown> };

/** Default time for a reminder when the user picked a day but no time. Shown to the user before saving. */
export const DEFAULT_REMINDER_TIME = '09:00';

/** Pure mapping from a reviewed proposal to a database insert. Throws if a required date is missing. */
export function planInsert(item: ProposedItem, ctx: { timezone: string; sessionId: string | null; language: string | null; categoryIds: Map<string, string> }): InsertPlan {
  const category_id = item.category ? ctx.categoryIds.get(item.category.toLowerCase()) ?? null : null;
  const base = { category_id, voice_session_id: ctx.sessionId };
  switch (item.type) {
    case 'task':
      return {
        table: 'tasks',
        row: {
          ...base, title: item.title, details: item.body, priority: item.priority, due_date: item.date,
          due_at: item.date && item.time ? zonedTimeToUtc(item.date, item.time, ctx.timezone).toISOString() : null,
        },
      };
    case 'reminder':
      if (!item.date) throw new ApiError('needs_date', `"${item.title}" needs a date`);
      return {
        table: 'reminders',
        row: {
          ...base, title: item.title, notes: item.body, timezone: ctx.timezone,
          remind_at: zonedTimeToUtc(item.date, item.time ?? DEFAULT_REMINDER_TIME, ctx.timezone).toISOString(),
        },
      };
    case 'event':
      if (!item.date) throw new ApiError('needs_date', `"${item.title}" needs a date`);
      return {
        table: 'events',
        row: {
          ...base, title: item.title, notes: item.body, all_day: !item.time,
          starts_at: zonedTimeToUtc(item.date, item.time ?? '00:00', ctx.timezone).toISOString(),
        },
      };
    default:
      return {
        table: 'notes',
        row: { ...base, title: item.title, body: item.body ?? item.title, kind: item.type, language: ctx.language },
      };
  }
}

export interface CommitOutcome { index: number; ok: boolean; error?: unknown }

/** Saves each included item independently so one failure (e.g. plan limit) doesn't lose the others. */
export async function commitItems(items: ReviewedItem[], ctx: { timezone: string; sessionId: string | null; language: string | null; categories: Category[] }): Promise<CommitOutcome[]> {
  const categoryIds = new Map(ctx.categories.map((c) => [c.name.toLowerCase(), c.id]));
  const outcomes: CommitOutcome[] = [];
  for (const [index, item] of items.entries()) {
    if (!item.include) continue;
    try {
      const plan = planInsert(item, { ...ctx, categoryIds });
      check(await supabase.from(plan.table).insert(plan.row));
      outcomes.push({ index, ok: true });
    } catch (error) {
      outcomes.push({ index, ok: false, error });
    }
  }
  if (ctx.sessionId && outcomes.some((o) => o.ok)) {
    await supabase.from('voice_sessions').update({ status: 'committed' }).eq('id', ctx.sessionId);
  }
  return outcomes;
}

// ---------------- Daily priorities (deterministic, explainable) ----------------
export interface PriorityEntry { task: Task; reason: 'overdue' | 'today' | 'high' }

export function rankPriorities(tasks: Task[], today: string, limit = 5): PriorityEntry[] {
  const open = tasks.filter((t) => t.status === 'open');
  const REASONS = ['overdue', 'today', 'high'] as const;
  const score = (t: Task): 0 | 1 | 2 | 3 => {
    if (t.due_date && t.due_date < today) return 0;
    if (t.due_date === today) return 1;
    if (t.priority === 'high') return 2;
    return 3;
  };
  return open
    .filter((t) => score(t) < 3)
    .sort((a, b) => score(a) - score(b) || (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0) || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
    .slice(0, limit)
    .map((task) => ({ task, reason: REASONS[score(task) as 0 | 1 | 2] }));
}
