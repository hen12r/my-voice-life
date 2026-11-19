-- =====================================================================
-- My Voice Life — PRE-FLIGHT INSPECTION (READ-ONLY, ONE SELECT STATEMENT)
-- Paste into Supabase Dashboard → SQL Editor and run. Returns ONE row with
-- ONE column (preflight_report) containing a JSON report.
-- It reads catalog metadata and row COUNTS only: no emails, no user data,
-- no secrets. It is a single SELECT: it cannot create, change or delete
-- anything, and it does not touch permissions.
-- Works on a brand-new project (missing tables are reported as empty/null).
-- =====================================================================
select jsonb_pretty(jsonb_build_object(
  'postgres_version', version(),

  -- 1. Tables in the public schema, with row counts and whether RLS is on
  'public_tables', coalesce((
    select jsonb_agg(jsonb_build_object(
             'table', c.relname,
             'rows', (xpath('/row/n/text()',
                       query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint,
             'rls_enabled', c.relrowsecurity) order by c.relname)
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'), '[]'::jsonb),

  -- 2. Tables the two migrations create that ALREADY exist (expected: [])
  'table_name_collisions', coalesce((
    select jsonb_agg(t order by t)
    from unnest(array[
      'categories','voice_sessions','notes','tasks','reminders','events','subscriptions','usage_counters',
      'mvl_app_settings','mvl_staff','mvl_plan_limits','mvl_plan_prices','mvl_fee_schedules','mvl_price_book',
      'mvl_ai_usage','mvl_budget_alerts','mvl_operating_expenses','mvl_daily_activity']) t
    where to_regclass('public.' || t) is not null), '[]'::jsonb),

  -- 3. Structure of public.profiles, if it exists
  'profiles_columns', coalesce((
    select jsonb_agg(jsonb_build_object('column', column_name, 'type', data_type,
             'nullable', is_nullable, 'default', column_default) order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'), '[]'::jsonb),
  'profiles_constraints', coalesce((
    select jsonb_agg(jsonb_build_object('name', conname, 'type', contype::text,
             'definition', pg_get_constraintdef(oid)) order by conname)
    from pg_constraint where conrelid = to_regclass('public.profiles')), '[]'::jsonb),

  -- 4. Existing RLS policies in public (migration 1 replaces those on profiles)
  'policies', coalesce((
    select jsonb_agg(jsonb_build_object('table', tablename, 'policy', policyname, 'command', cmd,
             'roles', roles, 'using', qual, 'with_check', with_check) order by tablename, policyname)
    from pg_policies where schemaname = 'public'), '[]'::jsonb),

  -- 5. Triggers on auth.users (sign-up logic)
  'auth_users_triggers', coalesce((
    select jsonb_agg(jsonb_build_object('trigger', t.tgname, 'function', p.proname,
             'enabled', t.tgenabled::text) order by t.tgname)
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = to_regclass('auth.users') and not t.tgisinternal), '[]'::jsonb),

  -- 6. Functions whose names the migrations use (expected: [])
  'function_name_collisions', coalesce((
    select jsonb_agg(jsonb_build_object('function', proname,
             'args', pg_get_function_identity_arguments(oid)) order by proname)
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and (proname like 'mvl\_%' or proname in ('tasks_completed_at','effective_plan','search_memory'))), '[]'::jsonb),

  -- 7. Counts that could make constraints fail (no personal data)
  'auth_users_count', (select count(*) from auth.users),
  'profiles_without_auth_user', case when to_regclass('public.profiles') is null then null else
    (xpath('/row/n/text()', query_to_xml(
       'select count(*) as n from public.profiles p where not exists (select 1 from auth.users u where u.id = p.id)',
       false, true, '')))[1]::text::bigint end,

  -- 8. Installed extensions
  'extensions', coalesce((
    select jsonb_agg(jsonb_build_object('name', extname, 'version', extversion) order by extname)
    from pg_extension), '[]'::jsonb)
)) as preflight_report;
