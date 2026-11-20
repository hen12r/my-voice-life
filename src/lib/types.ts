/** ISO 639 code. Which codes exist and how well each is supported: supabase/functions/_shared/languages.ts */
export type UiLanguage = string;
/** 'auto' or an ISO 639 code (legacy single choice; speech_languages is the full list). */
export type SpeechLanguage = string;

export interface Profile {
  id: string;
  display_name: string | null;
  ui_language: UiLanguage;
  speech_language: SpeechLanguage;
  /** Up to 3 languages the user speaks, sent to transcription as hints. Empty = automatic. */
  speech_languages: string[];
  timezone: string;
  daily_briefing_enabled: boolean;
}

export interface Category { id: string; name: string; color: string | null; is_default: boolean }

export type NoteKind = 'note' | 'idea' | 'personal_info';
export interface Note {
  id: string; title: string | null; body: string; kind: NoteKind; category_id: string | null;
  language: string | null; is_pinned: boolean; voice_session_id: string | null; created_at: string; updated_at: string;
}

export type Priority = 'low' | 'normal' | 'high';
export interface Task {
  id: string; title: string; details: string | null; status: 'open' | 'done'; priority: Priority;
  due_date: string | null; due_at: string | null; completed_at: string | null; category_id: string | null; created_at: string;
}

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
export interface Reminder {
  id: string; title: string; notes: string | null; remind_at: string; timezone: string; recurrence: Recurrence;
  status: 'scheduled' | 'done' | 'cancelled'; category_id: string | null; created_at: string;
}

export interface CalendarEvent {
  id: string; title: string; notes: string | null; location: string | null; starts_at: string; ends_at: string | null;
  all_day: boolean; category_id: string | null; created_at: string;
}

export interface Subscription {
  plan: 'free' | 'premium'; status: string; billing_interval: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean; has_billing_account: boolean;
}
/** From the billing Edge Function: prices are read from Stripe, limits from mvl_plan_limits. */
export interface BillingInfo {
  configured: boolean;
  test_mode: boolean;
  prices: { interval: 'month' | 'year'; amount: number; currency: string }[];
  limits: Record<string, { ai_captures_per_month: number; audio_minutes_per_month: number; max_capture_seconds: number }>;
}
/** From mvl_my_usage(): the caller's own AI allowance (counted on the server). */
export interface MyUsage {
  plan: 'free' | 'premium';
  is_staff: boolean;
  is_admin: boolean;
  ai_mode: 'on' | 'admins_only' | 'off';
  ai_available: boolean;
  ai_paused_message: string | null;
  captures_used: number;
  captures_limit: number;
  minutes_used: number;
  minutes_limit: number;
  max_capture_seconds: number;
  resets_at: string;
}

export interface PlanLimits {
  plan: 'free' | 'premium';
  ai_captures_per_month: number;
  audio_minutes_per_month: number;
  max_capture_seconds: number;
  captures_per_hour: number;
  captures_per_day: number;
}

export interface BudgetAlert {
  id: number; period: 'day' | 'month'; period_start: string; threshold: number;
  spend_usd: number; budget_usd: number; created_at: string; acknowledged_at: string | null;
}

export interface AdminSettings {
  ai_mode: 'on' | 'admins_only' | 'off';
  ai_paused_message: string | null;
  daily_ai_budget_usd: number;
  monthly_ai_budget_usd: number;
  fx_usd_to_eur: number;
  vat_rate: number;
  prices_include_vat: boolean;
  fee_card_region: string;
  max_output_tokens_per_call: number;
  disable_thinking: boolean;
}

export interface AdminUsageSummary {
  month: string;
  settings: AdminSettings;
  spend_today_usd: number;
  spend_month_usd: number;
  totals: {
    captures_ok: number; captures_failed: number; captures_expired: number; captures_in_flight: number; refusals: number;
    audio_minutes: number; provider_calls: number; audio_tokens: number; text_in_tokens: number;
    output_tokens: number; thinking_tokens: number; est_cost_usd: number; active_ai_users: number;
  };
  refusals_by_reason: Record<string, number>;
  by_day: { day: string; captures: number; cost_usd: number }[];
  top_users: { user: string; plan: string; captures: number; audio_minutes: number; cost_usd: number }[];
  plan_limits: PlanLimits[];
  alerts: BudgetAlert[];
}

export interface Expense {
  id: number; month: string; service: string; category: string; amount: number;
  currency: 'USD' | 'EUR'; kind: 'actual' | 'estimate'; note: string | null;
}

export interface AdminFinanceSummary {
  month: string;
  currency: 'EUR';
  payments_active: boolean;
  labels: Record<'revenue' | 'net_revenue' | 'stripe_fees' | 'ai_costs' | 'operating_expenses' | 'contribution', string>;
  users: { total: number; monthly_active: number; premium: number; premium_monthly: number; premium_annual: number; free: number };
  revenue_gross_eur: number;
  revenue_net_eur: number;
  stripe_fees_eur: number;
  ai_costs_usd: number;
  ai_costs_eur: number;
  operating_expenses_eur: number;
  operating_expenses_actual_eur: number;
  estimated_contribution_eur: number;
  assumptions: { fx_usd_to_eur: number; vat_rate: number; prices_include_vat: boolean; fee_region: string; price_monthly_eur: number | null; price_annual_eur: number | null };
  expenses: Expense[];
}

export interface MemoryHit {
  record_type: 'note' | 'task' | 'reminder' | 'event'; id: string; title: string; snippet: string | null;
  occurred_at: string | null; created_at: string; rank: number;
}
