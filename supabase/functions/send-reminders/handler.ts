// POST /functions/v1/send-reminders — called every minute by the database scheduler (pg_cron +
// pg_net, supabase/ops/schedule_send_reminders.sql), never by browsers.
//  - Requires the header x-mvl-cron to equal the CRON_SECRET secret (constant-time compare).
//  - Claims due reminders atomically (mvl_push_claim_due: each occurrence at most once), then sends
//    one encrypted notification per device of the reminder's owner. Gone devices are removed.
//  - Logs COUNTS ONLY: never a title, endpoint, key or user id.
// If the VAPID keys are missing it refuses BEFORE claiming, so no reminder is marked as sent unsent.
import { type PushResult, type PushSubscriptionRow, type RawKeyPair, sendPush } from '../_shared/webpush.ts';

export interface DueReminder { reminder_id: string; owner_id: string; title: string; remind_at: string; timezone: string }
export interface Target extends PushSubscriptionRow { owner_id: string }
export interface SendDeps {
  cronSecret: string | undefined;
  vapid: { keys: RawKeyPair; subject: string } | null;
  db: {
    claimDue(limit: number): Promise<DueReminder[]>;
    targets(ownerIds: string[]): Promise<Target[]>;
    record(id: string, ok: boolean, gone: boolean): Promise<void>;
  };
  fetch: typeof fetch;
  log?: (msg: string) => void;
  batch?: number;
  concurrency?: number;
}

/** Constant-time comparison (length is not secret: the header has a fixed format). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createSendHandler(deps: SendDeps) {
  const log = deps.log ?? ((m: string) => console.log(m));
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const secret = deps.cronSecret?.trim();
    if (!secret || secret.length < 32) return reply(503, { error: 'cron_not_configured' });
    if (!safeEqual(req.headers.get('x-mvl-cron') ?? '', secret)) return reply(401, { error: 'unauthorized' });
    if (!deps.vapid) return reply(503, { error: 'push_not_configured' });

    const due = await deps.db.claimDue(deps.batch ?? 200);
    if (due.length === 0) return reply(200, { claimed: 0, sent: 0, failed: 0, removed: 0 });
    const targets = await deps.db.targets([...new Set(due.map((d) => d.owner_id))]);
    const byOwner = new Map<string, Target[]>();
    for (const t of targets) byOwner.set(t.owner_id, [...(byOwner.get(t.owner_id) ?? []), t]);

    const jobs: (() => Promise<PushResult>)[] = [];
    for (const r of due) {
      // The device formats the time in its own language and the reminder's time zone.
      const payload = { kind: 'reminder', id: r.reminder_id, title: r.title, at: r.remind_at, tz: r.timezone };
      for (const sub of byOwner.get(r.owner_id) ?? []) {
        jobs.push(async () => {
          const res = await sendPush(sub, payload, deps.vapid!, deps.fetch).catch(() => ({ id: sub.id, ok: false, gone: false, status: 0 }));
          await deps.db.record(res.id, res.ok, res.gone).catch(() => undefined);
          return res;
        });
      }
    }
    const results: PushResult[] = [];
    const width = Math.max(1, deps.concurrency ?? 10);
    for (let i = 0; i < jobs.length; i += width) results.push(...await Promise.all(jobs.slice(i, i + width).map((j) => j())));

    const summary = { claimed: due.length, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok && !r.gone).length, removed: results.filter((r) => r.gone).length };
    log(`send-reminders: claimed=${summary.claimed} sent=${summary.sent} failed=${summary.failed} removed=${summary.removed}`);
    return reply(200, summary);
  };
}
