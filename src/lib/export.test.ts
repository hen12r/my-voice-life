import { describe, expect, it } from 'vitest';
import { buildExport, EXPORT_TABLES, exportFileName } from './export';

describe('data export', () => {
  const now = new Date('2026-11-28T10:00:00Z');
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []])) as never as Parameters<typeof buildExport>[1];
  it('builds a versioned file with counts and drops internal search vectors', () => {
    const f = buildExport('u1', { ...tables, notes: [{ id: 'n1', body: 'hi', search: "'hi':1" }, { id: 'n2', body: 'yo' }] }, { subscription: null, usage: { plan: 'free' } }, now);
    expect(f.format).toBe('my-voice-life-export');
    expect(f.version).toBe(1);
    expect(f.exported_at).toBe('2026-11-28T10:00:00.000Z');
    expect(f.counts.notes).toBe(2);
    expect(f.counts.voice_sessions).toBe(0);
    expect(f.data.notes[0]).toEqual({ id: 'n1', body: 'hi' });
    expect(f.data.usage).toEqual({ plan: 'free' });
    expect(Object.keys(f.data)).toEqual([...EXPORT_TABLES, 'subscription', 'usage']);
  });
  it('names the file with the date', () => {
    expect(exportFileName(now)).toBe('my-voice-life-export-2026-11-28.json');
  });
});
