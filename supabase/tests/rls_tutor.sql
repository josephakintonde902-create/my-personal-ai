-- Tutor check: conversations and messages are isolated between users.
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up
-- and the Phase 5 migrations have been applied. It impersonates each user the
-- same way the API does, creates test subjects, conversations and messages,
-- and raises an error on the first rule that leaks. Everything is rolled back.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  subject_a uuid;
  subject_b uuid;
  conversation_a uuid;
  conversation_a2 uuid;
  conversation_b uuid;
  message_a uuid;
  message_b uuid;
  touched_at timestamptz;
  n int;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.tutor_conversations'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.tutor_conversations';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.tutor_messages'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.tutor_messages';
  end if;

  -- ------------------------------------------------------------------ user B
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Tutor test B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.tutor_conversations (subject_id, title) values (subject_b, 'B private chat') returning id into conversation_b;
  insert into public.tutor_messages (conversation_id, role, content)
  values (conversation_b, 'user', 'B SECRET question') returning id into message_b;
  insert into public.tutor_messages (conversation_id, role, content)
  values (conversation_b, 'assistant', 'B SECRET answer');

  -- ------------------------------------------------------------------ user A
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Tutor test A ' || gen_random_uuid()) returning id into subject_a;

  -- A can create conversations, with and without a subject, and read them.
  insert into public.tutor_conversations (subject_id, title) values (subject_a, 'A optics chat') returning id into conversation_a;
  insert into public.tutor_conversations (title) values ('A general chat') returning id into conversation_a2;

  if (select user_id from public.tutor_conversations where id = conversation_a) is distinct from user_a then
    raise exception 'FAIL: a new conversation is not owned by the user who created it';
  end if;
  select count(*) into n from public.tutor_conversations where id in (conversation_a, conversation_a2);
  if n <> 2 then raise exception 'FAIL: user A cannot read their own conversations'; end if;

  -- A can add messages to their own conversation and read them back in order.
  insert into public.tutor_messages (conversation_id, role, content)
  values (conversation_a, 'user', 'What is refraction?') returning id into message_a;
  insert into public.tutor_messages (conversation_id, role, content, sources)
  values (conversation_a, 'assistant', 'Refraction is the bending of light.',
          '[{"n":1,"materialId":"00000000-0000-4000-8000-000000000000","title":"Optics notes","subject":"Physics","page":14,"slide":null,"section":"Refraction"}]'::jsonb);

  if (select user_id from public.tutor_messages where id = message_a) is distinct from user_a then
    raise exception 'FAIL: a new message is not owned by the user who wrote it';
  end if;
  select count(*) into n from public.tutor_messages where conversation_id = conversation_a;
  if n <> 2 then raise exception 'FAIL: user A cannot read their own messages'; end if;

  -- Adding a message moves the conversation to the top of the list.
  select updated_at into touched_at from public.tutor_conversations where id = conversation_a;
  if touched_at is null or touched_at < (select created_at from public.tutor_conversations where id = conversation_a) then
    raise exception 'FAIL: adding a message did not update the conversation';
  end if;

  -- --------------------------------------------- A cannot see B's conversation
  select count(*) into n from public.tutor_conversations where id = conversation_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s conversation'; end if;

  select count(*) into n from public.tutor_conversations;
  if n <> (select count(*) from public.tutor_conversations where user_id = user_a) then
    raise exception 'FAIL: user A sees conversations that are not theirs';
  end if;

  select count(*) into n from public.tutor_messages where conversation_id = conversation_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s messages'; end if;

  select count(*) into n from public.tutor_messages where content like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user B''s messages are visible to user A'; end if;

  -- ------------------------------------------ A cannot write into B's data
  begin
    insert into public.tutor_messages (conversation_id, role, content)
    values (conversation_b, 'user', 'intruder');
    raise exception 'FAIL: user A added a message to user B''s conversation';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  begin
    insert into public.tutor_messages (user_id, conversation_id, role, content)
    values (user_b, conversation_b, 'assistant', 'forged owner');
    raise exception 'FAIL: user A created a message owned by user B';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.tutor_conversations (user_id, title) values (user_b, 'forged owner');
    raise exception 'FAIL: user A created a conversation owned by user B';
  exception when insufficient_privilege then null;
  end;

  -- A conversation cannot be pointed at another user's subject.
  begin
    insert into public.tutor_conversations (subject_id, title) values (subject_b, 'borrowed subject');
    raise exception 'FAIL: user A created a conversation on user B''s subject';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    update public.tutor_conversations set subject_id = subject_b where id = conversation_a;
    raise exception 'FAIL: user A moved a conversation to user B''s subject';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  update public.tutor_conversations set title = 'hijacked' where id = conversation_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can rename user B''s conversation'; end if;

  delete from public.tutor_conversations where id = conversation_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s conversation'; end if;

  -- ------------------------------------------------------- column privileges
  begin
    update public.tutor_conversations set user_id = user_b where id = conversation_a;
    raise exception 'FAIL: a conversation''s owner can be changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tutor_messages set content = 'edited' where id = message_a;
    raise exception 'FAIL: messages can be edited';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.tutor_messages where id = message_a;
    raise exception 'FAIL: single messages can be deleted';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------------------------- constraints
  begin
    insert into public.tutor_messages (conversation_id, role, content) values (conversation_a, 'system', 'x');
    raise exception 'FAIL: an unknown role was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.tutor_messages (conversation_id, role, content) values (conversation_a, 'user', '');
    raise exception 'FAIL: an empty message was accepted';
  exception when check_violation then null;
  end;

  -- ------------------------------------------------------------------ cascade
  -- Deleting a subject keeps the conversation and clears its subject.
  delete from public.subjects where id = subject_a;
  if (select subject_id from public.tutor_conversations where id = conversation_a) is not null then
    raise exception 'FAIL: deleting a subject did not clear it from the conversation';
  end if;
  if (select user_id from public.tutor_conversations where id = conversation_a) is distinct from user_a then
    raise exception 'FAIL: deleting a subject changed the conversation''s owner';
  end if;

  -- Deleting a conversation removes its messages, and only its messages.
  delete from public.tutor_conversations where id = conversation_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: user A could not delete their own conversation'; end if;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.tutor_conversations;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read conversations'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.tutor_messages;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read messages'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.tutor_conversations (title) values ('anonymous');
    raise exception 'FAIL: signed-out visitors can create conversations';
  exception when insufficient_privilege then null;
  end;

  -- ---------------------------------------------------------- final state
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.tutor_messages where conversation_id = conversation_a;
  if n <> 0 then raise exception 'FAIL: deleting a conversation did not remove its messages'; end if;
  select count(*) into n from public.tutor_messages where conversation_id = conversation_b;
  if n <> 2 then raise exception 'FAIL: user B''s messages were changed (% left)', n; end if;
  if (select title from public.tutor_conversations where id = conversation_b) <> 'B private chat' then
    raise exception 'FAIL: user B''s conversation was changed';
  end if;

  raise notice 'PASS: tutor conversations and messages are isolated between users.';
end;
$$;

rollback;
