-- Phase 5: tutor messages.
--
-- The messages of a conversation: what the student asked and what Ari
-- answered. Nothing about the AI provider (keys, endpoints, raw responses) is
-- stored here.

create table public.tutor_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- 'user' is the student, 'assistant' is Ari. Tutor instructions are built
  -- on the server for every request and are never stored, so there is no
  -- 'system' role.
  role text not null,
  content text not null,
  -- For Ari's messages: the passages from the student's materials that were
  -- given to the model, as [{ n, materialId, title, subject, page, slide,
  -- section }]. Kept so source references survive a page reload.
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),

  constraint tutor_messages_role_valid check (role in ('user', 'assistant')),
  constraint tutor_messages_content_length check (char_length(content) between 1 and 60000),
  constraint tutor_messages_sources_is_array check (jsonb_typeof(sources) = 'array'),

  -- The conversation must exist and be owned by this user. Deleting a
  -- conversation removes its messages.
  constraint tutor_messages_conversation_owner_fkey
    foreign key (conversation_id, user_id)
    references public.tutor_conversations (id, user_id) on delete cascade
);

comment on table public.tutor_messages is 'Messages exchanged between a student and the Ari tutor.';

-- Loading a conversation in order.
create index tutor_messages_conversation_created_idx on public.tutor_messages (conversation_id, created_at);
-- Counting a user's recent messages (rate limiting).
create index tutor_messages_user_created_idx on public.tutor_messages (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Keep the conversation's updated_at current
-- ---------------------------------------------------------------------------
-- Runs as the function owner (security definer) because users have no
-- privilege to write updated_at themselves. It is safe because: search_path
-- is empty and every object is schema-qualified; it only touches the
-- conversation the new message was just accepted into, which the foreign key
-- has already tied to the same owner; and it cannot be called directly.
create function public.touch_tutor_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tutor_conversations c
     set updated_at = now()
   where c.id = new.conversation_id
     and c.user_id = new.user_id;
  return null;
end;
$$;

revoke execute on function public.touch_tutor_conversation() from public, anon, authenticated;

create trigger tutor_messages_touch_conversation
  after insert on public.tutor_messages
  for each row execute function public.touch_tutor_conversation();

-- ---------------------------------------------------------------------------
-- Row Level Security: users can only see and add to their own messages.
-- ---------------------------------------------------------------------------
alter table public.tutor_messages enable row level security;

create policy "Users can view their own messages"
  on public.tutor_messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- The foreign key above adds the second half of this rule: the conversation
-- named by the message must belong to the same user.
create policy "Users can add messages to their own conversations"
  on public.tutor_messages for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Messages are never edited, and are only removed together with their
-- conversation (by the cascade). So there are no UPDATE or DELETE policies
-- and no such privileges.
revoke all on public.tutor_messages from anon, authenticated;
grant select on public.tutor_messages to authenticated;
grant insert (conversation_id, role, content, sources) on public.tutor_messages to authenticated;
