-- OpenAI per-minute pricing and multilingual profile tests. Run after all migrations (scripts/test-db.sh).
\set ON_ERROR_STOP on
\set QUIET on

create or replace function pg_temp.expect(cond boolean, label text) returns void language plpgsql as $$
begin if coalesce(cond, false) then raise notice 'PASS  %', label; else raise exception 'FAIL  %', label; end if; end $$;
create or replace function pg_temp.expect_error(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS  %', label; return; end;
  raise exception 'FAIL  % (statement succeeded but should have failed)', label;
end $$;
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
  execute 'set role authenticated';
end $$;

insert into auth.users (id, email) values
  ('0a000000-0000-0000-0000-000000000001', 'voice@test'),
  ('0a000000-0000-0000-0000-000000000002', 'lang@test');
insert into public.mvl_staff (user_id, role) values ('0a000000-0000-0000-0000-000000000001', 'tester');
update public.mvl_app_settings set ai_mode = 'admins_only', daily_ai_budget_usd = 2, monthly_ai_budget_usd = 20;

-- ===================== Price book =====================
select pg_temp.expect((select count(*) = 2 from public.mvl_price_book where provider = 'openai' and effective_to is null),
  'OpenAI voice and text pipeline prices seeded');
select pg_temp.expect((select audio_usd_per_minute = 0.0045 and text_in_usd_per_m = 0.10 and output_usd_per_m = 0.50
  from public.mvl_price_book where model = 'gpt-transcribe+gpt-6-luna'), 'voice pipeline: $0.0045/min audio, $0.10/$0.50 per 1M text');
select pg_temp.expect((select audio_usd_per_minute = 0 from public.mvl_price_book where model = 'gpt-6-luna'),
  'text-only pipeline has no audio charge');
select pg_temp.expect_error($$update public.mvl_price_book set audio_usd_per_minute = -1 where model = 'gpt-6-luna'$$,
  'negative per-minute price rejected');

-- ===================== Worst-case hold includes per-minute audio =====================
-- 60 s voice: 60/60*0.0045 + (6500*0.10 + 2*2048*0.50)/1e6 = 0.0045 + 0.002698 = 0.007198
select pg_temp.expect(public.mvl_capture_cost_ceiling(public.mvl_current_price('openai', 'gpt-transcribe+gpt-6-luna'), 60) = 0.007198,
  'voice ceiling for 60 s = $0.007198');
select pg_temp.expect(public.mvl_capture_cost_ceiling(public.mvl_current_price('openai', 'gpt-transcribe+gpt-6-luna'), 60.2) = 0.007273,
  'partial seconds are rounded up in the hold');
select pg_temp.expect(public.mvl_capture_cost_ceiling(public.mvl_current_price('openai', 'gpt-6-luna'), 0) = 0.002698,
  'text ceiling = $0.002698');

-- ===================== Reserve → record transcription → record text → finish =====================
do $$ declare r jsonb; c numeric; u public.mvl_ai_usage; begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'voice', 42, 'openai', 'gpt-transcribe+gpt-6-luna');
  perform pg_temp.expect((r->>'ok')::boolean, 'tester can reserve an OpenAI voice capture in admins_only mode');
  c := public.mvl_record_ai_transcription((r->>'reservation_id')::uuid, 45.3);
  perform pg_temp.expect(c = round(46 / 60.0 * 0.0045, 6), 'transcription cost = billed seconds (rounded up) x per-minute rate');
  c := public.mvl_record_ai_call((r->>'reservation_id')::uuid, 0, 1200, 300, 0);
  perform pg_temp.expect(c = round((1200 * 0.10 + 300 * 0.50) / 1e6, 6), 'extraction cost = tokens x price book');
  perform public.mvl_finish_ai_capture((r->>'reservation_id')::uuid, 'ok', null);
  execute 'reset role';
  select * into u from public.mvl_ai_usage where id = (r->>'reservation_id')::uuid;
  perform pg_temp.expect(u.audio_seconds = 45.3, 'ledger keeps the billed duration, not the client estimate');
  perform pg_temp.expect(u.provider_calls = 2 and u.status = 'ok', 'two provider calls recorded, capture closed ok');
  perform pg_temp.expect(u.est_cost_usd = round(46 / 60.0 * 0.0045, 6) + round((1200 * 0.10 + 300 * 0.50) / 1e6, 6), 'estimated cost is the sum of both calls');
end $$;

do $$ declare r jsonb; begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'voice', 10, 'openai', 'gpt-transcribe+gpt-6-luna');
  perform public.mvl_finish_ai_capture((r->>'reservation_id')::uuid, 'failed', 'test');
  begin
    perform public.mvl_record_ai_transcription((r->>'reservation_id')::uuid, 10);
    execute 'reset role';
    raise exception 'FAIL  recording on a closed reservation should fail';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    execute 'reset role';
    raise notice 'PASS  cannot record usage on a closed reservation';
  end;
end $$;

do $$ declare r jsonb; begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'voice', 10, 'openai', 'gpt-transcribe+gpt-6-luna');
  begin
    perform public.mvl_record_ai_transcription((r->>'reservation_id')::uuid, -1);
    execute 'reset role';
    raise exception 'FAIL  negative duration should be rejected';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    execute 'reset role';
    raise notice 'PASS  negative billed duration rejected';
  end;
end $$;

do $$ declare r jsonb; begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'voice', 10, 'openai', 'gpt-transcribe+unknown-model');
  execute 'reset role';
  perform pg_temp.expect(r->>'reason' = 'ai_price_unknown', 'a model without a price row fails closed');
end $$;

do $$ declare r jsonb; begin
  execute 'set role service_role';
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000002', 'voice', 10, 'openai', 'gpt-transcribe+gpt-6-luna');
  execute 'reset role';
  perform pg_temp.expect(r->>'reason' = 'ai_test_mode', 'non-staff user refused while AI is admins_only');
end $$;

select pg_temp.as_user('0a000000-0000-0000-0000-000000000002');
select pg_temp.expect_error($$select public.mvl_record_ai_transcription(gen_random_uuid(), 10)$$, 'user cannot call record_ai_transcription');
reset role;

-- ===================== Free plan: 7 captures; quota counts billed minutes =====================
do $$ declare r jsonb; i int; begin
  execute 'set role service_role';
  for i in 1..7 loop
    r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'text', 0, 'openai', 'gpt-6-luna');
    if (r->>'ok')::boolean then perform public.mvl_finish_ai_capture((r->>'reservation_id')::uuid, 'ok', null); end if;
  end loop;
  r := public.mvl_reserve_ai_capture('0a000000-0000-0000-0000-000000000001', 'text', 0, 'openai', 'gpt-6-luna');
  execute 'reset role';
  perform pg_temp.expect(r->>'reason' in ('quota_captures', 'rate_limited_hour', 'rate_limited_day'), format('free allowance enforced for OpenAI captures (%s)', r->>'reason'));
end $$;

-- ===================== Multilingual profiles =====================
select pg_temp.as_user('0a000000-0000-0000-0000-000000000002');
update public.profiles set ui_language = 'sw', speech_languages = array['rw', 'fr', 'en'], speech_language = 'rw';
select pg_temp.expect((select ui_language = 'sw' and speech_languages = array['rw', 'fr', 'en'] from public.profiles),
  'owner can set any interface language code and up to 3 spoken languages');
select pg_temp.expect_error($$update public.profiles set speech_languages = array['rw','fr','en','sw']$$, 'more than 3 spoken languages rejected');
select pg_temp.expect_error($$update public.profiles set speech_languages = array['fr','Kinyarwanda']$$, 'invalid spoken-language code rejected');
select pg_temp.expect_error($$update public.profiles set speech_language = 'french'$$, 'invalid legacy speech_language rejected');
update public.profiles set ui_language = 'zh-cn';
select pg_temp.expect((select ui_language = 'zh-cn' from public.profiles), 'regional codes accepted (zh-cn)');
reset role;
select pg_temp.as_user('0a000000-0000-0000-0000-000000000001');
select pg_temp.expect((select count(*) = 1 from public.profiles), 'a user still sees only their own profile');
update public.profiles set speech_languages = array['de'] where id = '0a000000-0000-0000-0000-000000000002';
reset role;
select pg_temp.expect((select speech_languages = array['rw', 'fr', 'en'] from public.profiles where id = '0a000000-0000-0000-0000-000000000002'),
  'a user cannot change another user''s spoken languages');

-- Notes keep the original language; search works across scripts.
select pg_temp.as_user('0a000000-0000-0000-0000-000000000002');
insert into public.notes (body, language) values ('Ejo nzahamagara ishuri', 'rw'), ('明天给学校打电话', 'zh'), ('Appeler l''école demain', 'fr');
select pg_temp.expect((select count(*) = 1 from public.search_memory('ishuri')), 'search finds a Kinyarwanda note');
select pg_temp.expect((select count(*) = 1 from public.search_memory('学校')), 'search finds Chinese text inside a sentence (no spaces)');
select pg_temp.expect((select count(*) = 1 from public.search_memory('école')), 'search finds a French note with accents');
select pg_temp.expect((select string_agg(language, ',' order by language) = 'fr,rw,zh' from public.notes), 'original language is stored per note');
reset role;

\echo 'ALL OPENAI + MULTILINGUAL TESTS PASSED'
