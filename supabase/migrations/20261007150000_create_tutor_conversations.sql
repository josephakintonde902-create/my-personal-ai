-- Phase 5: tutor conversations.
--
-- A conversation is one chat between a student and Ari. It can be tied to a
-- subject (Ari then searches only that subject's materials) or to none
-- ("All materials"). Every row belongs to exactly one auth user.

create table public.tutor_conversations (
  id uuid primary key default gen_random_uuid(),
  -- Filled in from the session. Clients are not granted this column, so they
  -- cannot supply or change an owner (see the grants below).
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Null means "All materials".
  subject_id uuid,
  title text not null,
  created_at timestamptz not null default now(),
  -- Moved forward whenever a message is added (see the tutor_messages
  -- migration), so the conversation list can show the latest first.
  updated_at timestamptz not null default now(),

  constraint tutor_conversations_title_length check (char_length(btrim(title)) between 1 and 120),

  -- The subject must belong to the same user as the conversation, so a
  -- conversation can never point at someone else's subject. Deleting the
  -- subject keeps the conversation and clears only the subject.
  constraint tutor_conversations_subject_owner_fkey
    foreign key (subject_id, user_id)
    references public.subjects (id, user_id) on delete set null (subject_id),

  -- Target for the composite foreign key on tutor_messages, which guarantees
  -- a message and its conversation always share the same owner.
  constraint tutor_conversations_id_user_id_key unique (id, user_id)
);

comment on table public.tutor_conversations is 'User-owned chats with the Ari tutor.';

-- The conversation list: one user's conversations, most recent first.
create index tutor_conversations_user_updated_idx on public.tutor_conversations (user_id, updated_at desc);
create index tutor_conversations_subject_idx on public.tutor_conversations (subject_id) where subject_id is not null;

-- Reuses the function created in Phase 2.
create trigger tutor_conversations_set_updated_at
  before update on public.tutor_conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: users can only see and change their own conversations.
-- ---------------------------------------------------------------------------
alter table public.tutor_conversations enable row level security;

create policy "Users can view their own conversations"
  on public.tutor_conversations for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own conversations"
  on public.tutor_conversations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own conversations"
  on public.tutor_conversations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own conversations"
  on public.tutor_conversations for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Column-level privileges underneath RLS. Signed-out requests get nothing.
-- Signed-in users can write only the subject and the title: id, user_id and
-- the timestamps are never writable through the API.
revoke all on public.tutor_conversations from anon, authenticated;
grant select, delete on public.tutor_conversations to authenticated;
grant insert (subject_id, title) on public.tutor_conversations to authenticated;
grant update (subject_id, title) on public.tutor_conversations to authenticated;
