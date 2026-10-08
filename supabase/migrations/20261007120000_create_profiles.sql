-- Phase 2: user profiles.
--
-- One row per Supabase Auth user. profiles.id IS the auth user id, so future
-- user-owned tables (subjects, materials, quizzes, ...) can reference
-- public.profiles (id) and use the same `auth.uid()` ownership check.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_length check (char_length(full_name) <= 100),
  constraint profiles_bio_length check (char_length(bio) <= 500),
  constraint profiles_avatar_url_length check (char_length(avatar_url) <= 2048)
);

comment on table public.profiles is 'Public profile for each auth user. id equals auth.users.id.';

-- No extra indexes: every lookup is by primary key.

-- ---------------------------------------------------------------------------
-- updated_at handling (reusable by future tables)
-- ---------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: a user can read and update only their own row.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No insert or delete policies: rows are created by the trigger below and
-- removed by the cascade when the auth user is deleted.

-- Privileges are narrowed as a second layer underneath RLS. Signed-out (anon)
-- requests get nothing, and signed-in users can change only the editable
-- columns, never id or created_at.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url, bio) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Automatic profile creation
-- ---------------------------------------------------------------------------
-- Runs as the function owner (security definer) because the auth service role
-- that inserts into auth.users has no rights on public.profiles. It is safe
-- because: search_path is empty and every object is schema-qualified; the only
-- user-controlled input is the display name, which is trimmed and truncated to
-- fit the table constraint; and it cannot be called directly (execute is
-- revoked below, and trigger functions cannot be invoked as RPCs anyway).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(
      left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), 100),
      ''
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill for any auth users that already exist when this migration runs.
insert into public.profiles (id, full_name)
select
  u.id,
  nullif(left(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), 100), '')
from auth.users u
on conflict (id) do nothing;
