import { describe, expect, it } from 'vitest';
import { MAX_SCHEDULED, notificationId, planNotifications } from './reminders';

const now = new Date('2026-11-28T10:00:00Z');
const r = (id: string, offsetMin: number, extra: Partial<{ status: 'scheduled' | 'done' | 'cancelled'; title: string }> = {}) => ({
  id, title: extra.title ?? `R ${id}`, remind_at: new Date(now.getTime() + offsetMin * 60_000).toISOString(), timezone: 'Africa/Kigali', status: extra.status ?? 'scheduled' as const,
});

describe('native reminder schedule', () => {
  it('keeps only future scheduled reminders, soonest first', () => {
    const plan = planNotifications([r('b', 120), r('past', -5), r('a', 30), r('done', 60, { status: 'done' }), r('x', 90, { status: 'cancelled' })], now, 'en-GB');
    expect(plan.map((p) => p.reminderId)).toEqual(['a', 'b']);
    expect(plan[0].body).toBe('12:30'); // 10:30 UTC = 12:30 in Kigali
  });
  it(`never schedules more than iOS allows (${MAX_SCHEDULED} of 64)`, () => {
    const many = Array.from({ length: 100 }, (_, i) => r(`id-${i}`, i + 1));
    const plan = planNotifications(many, now);
    expect(plan).toHaveLength(MAX_SCHEDULED);
    expect(plan[0].reminderId).toBe('id-0');
  });
  it('gives each reminder a stable positive integer id', () => {
    const id = notificationId('3c30d720-400f-4956-9c11-ed5dec974d1c');
    expect(id).toBe(notificationId('3c30d720-400f-4956-9c11-ed5dec974d1c'));
    expect(Number.isInteger(id) && id > 0 && id < 2 ** 31).toBe(true);
    expect(id).not.toBe(notificationId('3c30d720-400f-4956-9c11-ed5dec974d1d'));
  });
});
