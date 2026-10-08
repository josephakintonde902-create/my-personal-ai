-- Phase 3: subjects.
--
-- A subject is a user-owned folder for study materials ("Mathematics",
-- "Biology"). Every row belongs to exactly one auth user.

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  -- Filled in from the session. Clients are not granted this column, so they
  -- cannot supply or change an owner (see the grants below).
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  description text,
  -- color and icon hold keys from the app's palette (lib/library/config.ts),
  -- not raw CSS or markup.
  color text,
  icon text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subjects_name_not_empty check (char_length(btrim(name)) between 1 and 80),
  constraint subjects_description_length check (char_length(description) <= 500),
  constraint subjects_color_format check (color ~ '^[a-z][a-z0-9-]{0,29}$'),
  constraint subjects_icon_format check (icon ~ '^[a-z][a-z0-9-]{0,29}$'),
  -- Target for the composite foreign key on study_materials, which guarantees
  -- a material and its subject always share the same owner.
  constraint subjects_id_user_id_key unique (id, user_id)
);

comment on table public.subjects is 'User-owned subjects that group study materials.';

create index subjects_user_id_idx on public.subjects (user_id);

-- One subject per name per user, ignoring case ("Biology" vs "biology").
create unique index subjects_user_id_name_key on public.subjects (user_id, lower(btrim(name)));

-- Reuses the function created in Phase 2.
create trigger subjects_set_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: users can only see and change their own subjects.
-- ---------------------------------------------------------------------------
alter table public.subjects enable row level security;

create policy "Users can view their own subjects"
  on public.subjects for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own subjects"
  on public.subjects for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own subjects"
  on public.subjects for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own subjects"
  on public.subjects for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Column-level privileges underneath RLS. Signed-out requests get nothing.
-- Signed-in users can write only the editable columns: id, user_id and the
-- timestamps are never writable through the API.
revoke all on public.subjects from anon, authenticated;
grant select, delete on public.subjects to authenticated;
grant insert (name, description, color, icon) on public.subjects to authenticated;
grant update (name, description, color, icon) on public.subjects to authenticated;
