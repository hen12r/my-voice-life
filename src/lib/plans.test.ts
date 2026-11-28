import { describe, expect, it } from 'vitest';
import { errorMessage, translate, type TranslationKey } from './i18n';
import { planFeatures, voiceAccess } from './plans';
import type { MyUsage, PlanCaps } from './types';

const t = (k: TranslationKey) => translate('en', k);
const base: MyUsage = {
  plan: 'free', is_staff: false, is_admin: false, ai_mode: 'admins_only', ai_available: false, ai_paused_message: null,
  captures_used: 0, captures_limit: 7, minutes_used: 0, minutes_limit: 15, max_capture_seconds: 120, resets_at: '2026-12-01T00:00:00Z',
  byoai_mode: 'everyone', byoai_allowed: true, byoai_connected: false, byoai_key_invalid: false, byoai_used_today: 0,
  byoai_captures_per_day: 10, byoai_max_capture_seconds: 120,
};

describe('voiceAccess (mirrors the server; display only)', () => {
  it('own key connected and allowed → BYOAI with the plan limits', () => {
    expect(voiceAccess({ ...base, byoai_connected: true, byoai_used_today: 3 })).toEqual({ mode: 'byoai', maxSeconds: 120, usedToday: 3, perDay: 10 });
  });
  it('the own key wins over the platform key, as on the server', () => {
    expect(voiceAccess({ ...base, is_staff: true, ai_available: true, byoai_connected: true }).mode).toBe('byoai');
  });
  it('no key, staff with the platform key → platform path', () => {
    expect(voiceAccess({ ...base, is_staff: true, ai_available: true })).toEqual({ mode: 'platform', maxSeconds: 120 });
  });
  it('no key connected → asks the user to connect one, with a link to Settings', () => {
    expect(voiceAccess(base)).toEqual({ mode: 'blocked', reason: 'errors.ai_key_required', fixLink: '/app/settings' });
  });
  it('rejected key → tells the user to reconnect', () => {
    expect(voiceAccess({ ...base, byoai_key_invalid: true })).toMatchObject({ mode: 'blocked', reason: 'errors.ai_key_invalid' });
  });
  it('kill switch and BYOAI not open yet → blocked with the right reason', () => {
    expect(voiceAccess({ ...base, ai_mode: 'off', byoai_allowed: false })).toMatchObject({ mode: 'blocked', reason: 'errors.ai_paused' });
    expect(voiceAccess({ ...base, byoai_mode: 'admins_only', byoai_allowed: false, byoai_connected: true })).toMatchObject({ mode: 'blocked', reason: 'errors.ai_test_mode' });
    expect(voiceAccess({ ...base, byoai_mode: 'off', byoai_allowed: false })).toMatchObject({ mode: 'blocked', reason: 'errors.byoai_off' });
  });
  it('before migration 6 (no BYOAI fields) the old behaviour is kept', () => {
    const old = { ...base } as Partial<MyUsage>;
    for (const k of ['byoai_mode', 'byoai_allowed', 'byoai_connected', 'byoai_key_invalid'] as const) delete old[k];
    expect(voiceAccess({ ...(old as MyUsage), ai_available: true }).mode).toBe('platform');
  });
});

describe('planFeatures (only real features, from the server limits)', () => {
  const free: PlanCaps = { ai_captures_per_month: 7, audio_minutes_per_month: 15, max_capture_seconds: 120, max_active_reminders: 10, max_upcoming_events: 20, max_ai_connections: 1, byoai_captures_per_hour: 5, byoai_captures_per_day: 10, byoai_max_capture_seconds: 120 };
  const pro: PlanCaps = { ...free, ai_captures_per_month: 600, audio_minutes_per_month: 1200, max_capture_seconds: 600, max_active_reminders: null, max_upcoming_events: null, byoai_captures_per_day: 200, byoai_max_capture_seconds: 600 };
  it('shows caps and the included AI allowance from the limits table (hybrid model)', () => {
    const f = planFeatures(t, free, 'en');
    expect(f).toContain('Up to 10 active reminders');
    expect(f).toContain('Up to 20 upcoming calendar events');
    expect(f.some((x) => x.includes('up to 10 captures a day') && x.includes('2 min'))).toBe(true);
    expect(f).toContain('7 AI voice captures and 15 min of audio a month included');
    expect(f.some((x) => x.startsWith('Optional: your own OpenAI key'))).toBe(true);
  });
  it('null caps read as unlimited', () => {
    const f = planFeatures(t, pro, 'en');
    expect(f).toContain('Unlimited reminders');
    expect(f.some((x) => x.includes('200 captures a day') && x.includes('10 min'))).toBe(true);
    expect(f).toContain('600 AI voice captures and 1,200 min of audio a month included');
  });
  it('never claims features that do not exist', () => {
    const all = [...planFeatures(t, free, 'en'), ...planFeatures(t, pro, 'en')].join(' ').toLowerCase();
    for (const fake of ['priority support', 'workflow', 'multiple providers', 'advanced organisation', 'integrations']) expect(all).not.toContain(fake);
  });
});

describe('plan limit errors from the database', () => {
  it('maps the trigger markers to clear messages', () => {
    expect(errorMessage(t, { code: 'P0001', message: 'PLAN_LIMIT_REMINDERS: 10 active reminders on your plan' })).toBe(t('errors.plan_limit_reminders'));
    expect(errorMessage(t, new Error('PLAN_LIMIT_EVENTS: 20 upcoming events on your plan'))).toBe(t('errors.plan_limit_events'));
  });
  it('every new BYOAI and billing error code has an English and a French message', () => {
    const codes = ['invalid_key', 'key_rejected', 'key_no_permission', 'key_missing_models', 'provider_unavailable', 'plan_limit_ai_connections',
      'too_many_attempts', 'connection_failed', 'unsupported_provider', 'plan_limit_reminders', 'plan_limit_events', 'ai_key_required',
      'ai_key_invalid', 'ai_key_no_model_access', 'ai_key_no_credit', 'byoai_off', 'no_subscription', 'already_on_plan'];
    const missing = codes.filter((c) => !translate('en', `errors.${c}` as TranslationKey) || translate('fr', `errors.${c}` as TranslationKey) === translate('en', `errors.${c}` as TranslationKey));
    expect(missing).toEqual([]);
  });
  it('survives an older backend that sends fewer limit fields (no crash, no false "unlimited")', () => {
    const t = (k: TranslationKey) => translate('en', k);
    const old = { ai_captures_per_month: 7, audio_minutes_per_month: 15, max_capture_seconds: 120 } as unknown as PlanCaps;
    const lines = planFeatures(t, old, 'en');
    expect(lines).toContain(translate('en', 'plan.f.included').replace('{n}', '7').replace('{m}', '15'));
    expect(lines).not.toContain(translate('en', 'plan.f.remindersUnlimited'));
    expect(lines.some((l) => l.includes('undefined') || l.includes('NaN'))).toBe(false);
  });
});
