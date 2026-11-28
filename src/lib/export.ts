// "Download all my data": everything the signed-in user owns, read with their own session under the
// existing row-level security (so it can only ever contain their rows), as one JSON file.
// No audio exists to export (it is never stored) and no secret is readable (the optional OpenAI key
// lives in Supabase Vault and is never returned to the browser).
import { supabase } from './supabase';
import { getMyUsage, getSubscription } from './api';

export const EXPORT_TABLES = ['profiles', 'categories', 'notes', 'tasks', 'reminders', 'events', 'voice_sessions'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];
const PAGE = 1000;
// Internal columns that carry no information for the user (search index vectors).
const DROP = new Set(['search']);

export interface ExportFile {
  format: 'my-voice-life-export';
  version: 1;
  exported_at: string;
  user_id: string;
  counts: Record<ExportTable, number>;
  data: Record<ExportTable, Record<string, unknown>[]> & { subscription: unknown; usage: unknown };
}

export class ExportError extends Error {
  constructor(public table: string, message: string) { super(message); }
}

/** Pure: assembles the file from the parts already fetched. */
export function buildExport(userId: string, tables: Record<ExportTable, Record<string, unknown>[]>, extra: { subscription: unknown; usage: unknown }, now: Date): ExportFile {
  const clean = Object.fromEntries(EXPORT_TABLES.map((t) => [t, (tables[t] ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !DROP.has(k))))])) as ExportFile['data'];
  return {
    format: 'my-voice-life-export',
    version: 1,
    exported_at: now.toISOString(),
    user_id: userId,
    counts: Object.fromEntries(EXPORT_TABLES.map((t) => [t, clean[t].length])) as Record<ExportTable, number>,
    data: { ...clean, subscription: extra.subscription, usage: extra.usage },
  };
}

export function exportFileName(now: Date): string {
  return `my-voice-life-export-${now.toISOString().slice(0, 10)}.json`;
}

/** Reads one table completely, page by page. Any error aborts the whole export (never a partial file). */
async function readAll(table: ExportTable): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new ExportError(table, error.message);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < PAGE) return rows;
  }
}

export async function exportAllData(userId: string, now = new Date()): Promise<ExportFile> {
  const parts = await Promise.all(EXPORT_TABLES.map(async (t) => [t, await readAll(t)] as const));
  const [subscription, usage] = await Promise.all([
    getSubscription().catch((e) => { throw new ExportError('subscriptions', String(e?.message ?? e)); }),
    getMyUsage().catch((e) => { throw new ExportError('usage', String(e?.message ?? e)); }),
  ]);
  return buildExport(userId, Object.fromEntries(parts) as Record<ExportTable, Record<string, unknown>[]>, { subscription, usage }, now);
}

/** Saves the file through the browser's normal download (nothing leaves the device). */
export function downloadJson(file: ExportFile, now = new Date()): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = exportFileName(now); a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
