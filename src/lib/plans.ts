// Hybrid AI model: each plan includes an AI allowance; users may also bring their own OpenAI key.
// Plan names, feature lists and voice access, shared by Pricing, Billing, Settings and Capture so
// they can never disagree. Every feature line is generated from the server's limits (mvl_plan_limits)
// and describes something that exists today. Nothing here decides access: the server does.
import type { TranslationKey } from './i18n';
import type { MyUsage, PaidPlan, Plan, PlanCaps } from './types';

export const PLANS: readonly Plan[] = ['free', 'plus', 'pro'];
export const PAID: readonly PaidPlan[] = ['plus', 'pro'];

export const planNameKey = (p: Plan): TranslationKey => (p === 'pro' ? 'plan.pro' : p === 'plus' ? 'plan.plus' : 'plan.free');

/** Feature lines for a plan, from its limits. `fmt` replaces {n} and {m}. */
export function planFeatures(t: (k: TranslationKey) => string, caps: PlanCaps | undefined, locale: string): string[] {
  const n = (v: number) => v.toLocaleString(locale);
  const out = [t('plan.f.notes')];
  if (caps) {
    out.push(caps.max_active_reminders == null ? t('plan.f.remindersUnlimited') : t('plan.f.reminders').replace('{n}', n(caps.max_active_reminders)));
    out.push(caps.max_upcoming_events == null ? t('plan.f.eventsUnlimited') : t('plan.f.events').replace('{n}', n(caps.max_upcoming_events)));
  }
  out.push(t('plan.f.memory'));
  if (caps) {
    out.push(t('plan.f.included').replace('{n}', n(caps.ai_captures_per_month)).replace('{m}', n(caps.audio_minutes_per_month)));
    out.push(t('plan.f.voice').replace('{n}', n(caps.byoai_captures_per_day)).replace('{m}', n(Math.round(caps.byoai_max_capture_seconds / 60 * 10) / 10)));
  }
  return out;
}

export type VoiceAccess =
  | { mode: 'byoai'; maxSeconds: number; usedToday: number; perDay: number }
  | { mode: 'platform'; maxSeconds: number }
  | { mode: 'blocked'; reason: TranslationKey; fixLink: '/app/settings' | '/app/notes' };

/**
 * Mirrors the server's choice (process-voice): the user's own key when connected and allowed,
 * else the platform key for staff testing, else blocked. Display only — the server re-checks.
 */
export function voiceAccess(u: MyUsage): VoiceAccess {
  if (u.byoai_connected && u.byoai_allowed) {
    return { mode: 'byoai', maxSeconds: u.byoai_max_capture_seconds ?? 120, usedToday: u.byoai_used_today ?? 0, perDay: u.byoai_captures_per_day ?? 0 };
  }
  if (u.ai_available) return { mode: 'platform', maxSeconds: u.max_capture_seconds };
  if (u.ai_mode === 'off') return { mode: 'blocked', reason: 'errors.ai_paused', fixLink: '/app/notes' };
  if (u.byoai_key_invalid) return { mode: 'blocked', reason: 'errors.ai_key_invalid', fixLink: '/app/settings' };
  if (u.byoai_allowed && !u.byoai_connected) return { mode: 'blocked', reason: 'errors.ai_key_required', fixLink: '/app/settings' };
  return { mode: 'blocked', reason: u.byoai_mode === 'off' ? 'errors.byoai_off' : 'errors.ai_test_mode', fixLink: '/app/notes' };
}
