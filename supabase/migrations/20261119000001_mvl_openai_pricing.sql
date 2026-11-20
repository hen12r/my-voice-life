-- =====================================================================
-- My Voice Life — OpenAI pricing for the voice pipeline (additive)
-- ---------------------------------------------------------------------
-- gpt-transcribe is billed per MINUTE of audio (not per token), so the price book gains a
-- per-minute rate, the worst-case hold includes it, and transcription calls are recorded by
-- duration. Prices verified on developers.openai.com on 2026-11-19:
--   gpt-transcribe  $0.0045 / minute         (docs/models/gpt-transcribe)
--   gpt-6-luna      $0.10 in / $0.50 out per 1M tokens (docs/models/gpt-6-luna)
-- The old Gemini rows are left untouched (inert: the code no longer requests them).
-- =====================================================================

do $$ begin
  if to_regclass('public.mvl_price_book') is null or to_regclass('public.mvl_ai_usage') is null then
    raise exception 'MVL pre-flight: apply 20261118000002_mvl_financial_controls.sql first.';
  end if;
end $$;

alter table public.mvl_price_book add column if not exists audio_usd_per_minute numeric(10, 6) not null default 0;
do $$ begin
  alter table public.mvl_price_book add constraint mvl_price_book_audio_minute_chk check (audio_usd_per_minute >= 0);
exception when duplicate_object then null; end $$;

-- One row per pipeline: voice capture = transcription + extraction; typed capture = extraction only.
insert into public.mvl_price_book (provider, model, audio_in_usd_per_m, text_in_usd_per_m, output_usd_per_m, audio_usd_per_minute, effective_from, source_url)
values ('openai', 'gpt-transcribe+gpt-6-luna', 0, 0.10, 0.50, 0.0045, '2026-11-19', 'https://developers.openai.com/api/docs/pricing'),
       ('openai', 'gpt-6-luna', 0, 0.10, 0.50, 0, '2026-11-19', 'https://developers.openai.com/api/docs/models/gpt-6-luna')
on conflict (provider, model, effective_from) do nothing;

-- Worst-case USD cost of one capture, now including per-minute audio billing
-- (rounded up to whole seconds).
create or replace function public.mvl_capture_cost_ceiling(p_price public.mvl_price_book, p_audio_seconds numeric)
returns numeric language sql stable security definer set search_path = ''
as $$
  select round((
      ceil(p_audio_seconds * 32) * p_price.audio_in_usd_per_m
    + s.max_text_in_tokens_per_capture * p_price.text_in_usd_per_m
    + 2 * s.max_output_tokens_per_call * p_price.output_usd_per_m
  ) / 1000000.0
    + ceil(p_audio_seconds) / 60.0 * p_price.audio_usd_per_minute, 6)
  from public.mvl_app_settings s
$$;

-- Records a per-minute transcription call on a reservation: cost = seconds × rate, and the
-- capture's audio length becomes the duration the provider billed (or the server-measured one).
create or replace function public.mvl_record_ai_transcription(p_reservation uuid, p_audio_seconds numeric)
returns numeric language plpgsql security definer set search_path = ''
as $$
declare r public.mvl_ai_usage; p public.mvl_price_book; v_cost numeric;
begin
  if p_audio_seconds is null or p_audio_seconds < 0 or p_audio_seconds > 7200 then
    raise exception 'invalid audio duration';
  end if;
  select * into r from public.mvl_ai_usage where id = p_reservation for update;
  if r.id is null or r.status <> 'reserved' then
    raise exception 'reservation % is not active', p_reservation;
  end if;
  select * into p from public.mvl_price_book where id = r.price_book_id;
  v_cost := ceil(p_audio_seconds) / 60.0 * coalesce(p.audio_usd_per_minute, 0);
  update public.mvl_ai_usage set
    provider_calls = provider_calls + 1,
    est_cost_usd = round(est_cost_usd + v_cost, 6),
    audio_seconds = round(p_audio_seconds, 2)
  where id = p_reservation;
  return round(v_cost, 6);
end;
$$;

-- Accounting path: Edge Function (service role) only.
revoke execute on function public.mvl_record_ai_transcription(uuid, numeric) from public, anon, authenticated;
grant execute on function public.mvl_record_ai_transcription(uuid, numeric) to service_role;
