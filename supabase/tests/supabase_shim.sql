-- TEST ONLY: minimal stand-in for the parts of Supabase the migration relies on
-- (roles, auth.users, auth.uid(), default grants). Never apply to a real project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase grants table privileges broadly and relies on RLS; mirror that so
-- the tests prove RLS, not missing grants, is what blocks access.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- TEST ONLY: stand-in for Supabase Vault (extension supabase_vault 0.3.x). Same function
-- signatures as the real project (checked on 2026-11-21); the real one encrypts `secret` at rest
-- with a key the database never exposes. Here the value is stored as is: tests prove WHO can reach
-- the secret, not the cryptography (which is Supabase's).
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql security definer set search_path = '' as $$
  insert into vault.secrets (secret, name, description, key_id) values (new_secret, new_name, new_description, new_key_id) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language sql security definer set search_path = '' as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
    description = coalesce(new_description, description), key_id = coalesce(new_key_id, key_id), updated_at = now()
  where id = secret_id
$$;
-- As on Supabase: API roles have no access to the vault schema.
revoke all on schema vault from public;
revoke all on all tables in schema vault from public;
revoke execute on all functions in schema vault from public;
