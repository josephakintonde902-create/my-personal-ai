-- Row Level Security check for subjects, study materials and their storage.
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up
-- and the Phase 3 migrations have been applied. It impersonates each user the
-- same way the API does and raises an error on the first rule that leaks.
-- Everything is rolled back, so no data is changed.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  subject_a uuid;
  subject_b uuid;
  material_a uuid := gen_random_uuid();
  material_b uuid := gen_random_uuid();
  n int;
  storage_checked boolean := true;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.subjects'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.subjects';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.study_materials'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.study_materials';
  end if;
  if (select public from storage.buckets where id = 'study-materials') is distinct from false then
    raise exception 'FAIL: the study-materials bucket is missing or public';
  end if;

  -- Storage rules are tested by writing rows to storage.objects, which is what
  -- the Storage API does. Find out first whether this project allows that from
  -- SQL at all, so a refusal later can only mean a policy denied it.
  begin
    insert into storage.objects (bucket_id, name) values ('study-materials', 'rls-probe/' || gen_random_uuid());
    delete from storage.objects where bucket_id = 'study-materials' and name like 'rls-probe/%';
  exception when others then
    storage_checked := false;
    raise notice 'SKIPPED storage checks (%). Verify storage isolation through the app instead.', sqlerrm;
  end;

  -- ------------------------------------------------------------------ user B
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('RLS test subject B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_b, subject_b, 'B notes', 'b.pdf', user_b || '/' || subject_b || '/' || material_b || '/b.pdf', 'application/pdf', 10, 'pdf');

  -- ------------------------------------------------------------------ user A
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('RLS test subject A ' || gen_random_uuid()) returning id into subject_a;
  if (select user_id from public.subjects where id = subject_a) <> user_a then
    raise exception 'FAIL: a new subject is not owned by the user who created it';
  end if;

  -- A can read and modify their own subject.
  update public.subjects set description = 'mine' where id = subject_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: user A cannot update their own subject'; end if;

  -- A cannot read, modify or delete B's subject.
  select count(*) into n from public.subjects where id = subject_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s subject'; end if;

  select count(*) into n from public.subjects where user_id <> user_a;
  if n <> 0 then raise exception 'FAIL: user A can see % subjects owned by other users', n; end if;

  update public.subjects set name = 'taken over' where id = subject_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can update user B''s subject'; end if;

  delete from public.subjects where id = subject_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s subject'; end if;

  -- A cannot create a subject owned by B, or hand a subject to B.
  begin
    insert into public.subjects (name, user_id) values ('forged owner', user_b);
    raise exception 'FAIL: user A can create a subject owned by user B';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.subjects set user_id = user_b where id = subject_a;
    raise exception 'FAIL: user A can change a subject''s owner';
  exception when insufficient_privilege then null;
  end;

  -- A can add a material to their own subject, and it starts as pending.
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_a, subject_a, 'A notes', 'a.pdf', user_a || '/' || subject_a || '/' || material_a || '/a.pdf', 'application/pdf', 10, 'pdf');
  if (select processing_status from public.study_materials where id = material_a) <> 'pending' then
    raise exception 'FAIL: a new material does not start as pending';
  end if;

  update public.study_materials set title = 'A notes (renamed)' where id = material_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: user A cannot rename their own material'; end if;

  -- A cannot attach a material to B's subject.
  begin
    insert into public.study_materials (subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
    values (subject_b, 'intruder', 'x.pdf', user_a || '/' || subject_b || '/' || gen_random_uuid() || '/x.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: user A can attach a material to user B''s subject';
  exception
    when insufficient_privilege or foreign_key_violation or check_violation then null;
  end;

  -- A cannot read, modify or delete B's material.
  select count(*) into n from public.study_materials where id = material_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s material'; end if;

  update public.study_materials set title = 'taken over' where id = material_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can update user B''s material'; end if;

  delete from public.study_materials where id = material_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s material'; end if;

  -- A cannot change ownership or processing state, even on their own material.
  begin
    update public.study_materials set user_id = user_b where id = material_a;
    raise exception 'FAIL: user A can change a material''s owner';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.study_materials set processing_status = 'ready' where id = material_a;
    raise exception 'FAIL: user A can change processing_status';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.study_materials set subject_id = subject_b where id = material_a;
    raise exception 'FAIL: user A can move a material into user B''s subject';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------------------------------ storage
  if storage_checked then
    -- A can upload into their own subject folder.
    begin
      insert into storage.objects (bucket_id, name, owner)
      values ('study-materials', user_a || '/' || subject_a || '/' || material_a || '/a.pdf', user_a);
    exception when insufficient_privilege then
      raise exception 'FAIL: user A cannot upload into their own subject folder';
    end;

    select count(*) into n from storage.objects
    where bucket_id = 'study-materials' and name like user_a || '/%';
    if n <> 1 then raise exception 'FAIL: user A cannot see their own file'; end if;

    -- B uploads a file, as B.
    perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
    insert into storage.objects (bucket_id, name, owner)
    values ('study-materials', user_b || '/' || subject_b || '/' || material_b || '/b.pdf', user_b);
    perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

    select count(*) into n from storage.objects
    where bucket_id = 'study-materials' and name like user_b || '/%';
    if n <> 0 then raise exception 'FAIL: user A can see user B''s files'; end if;

    delete from storage.objects where bucket_id = 'study-materials' and name like user_b || '/%';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL: user A can delete user B''s files'; end if;

    begin
      insert into storage.objects (bucket_id, name, owner)
      values ('study-materials', user_b || '/' || subject_b || '/' || gen_random_uuid() || '/x.pdf', user_a);
      raise exception 'FAIL: user A can upload into user B''s folder';
    exception when insufficient_privilege then null;
    end;

    begin
      insert into storage.objects (bucket_id, name, owner)
      values ('study-materials', user_a || '/' || subject_b || '/' || gen_random_uuid() || '/x.pdf', user_a);
      raise exception 'FAIL: user A can upload under a subject they do not own';
    exception when insufficient_privilege then null;
    end;
  end if;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.subjects;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read subjects'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.study_materials;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read study materials'; end if;
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from storage.objects where bucket_id = 'study-materials';
  if n <> 0 then raise exception 'FAIL: signed-out visitors can see study files'; end if;

  -- ------------------------------------------------------------------ cascade
  perform set_config('role', 'postgres', true);
  delete from public.subjects where id = subject_a;
  select count(*) into n from public.study_materials where id = material_a;
  if n <> 0 then raise exception 'FAIL: deleting a subject did not remove its materials'; end if;

  if storage_checked then
    raise notice 'PASS: subjects, study materials and study files are isolated between users.';
  else
    raise notice 'PASS (tables only): subjects and study materials are isolated between users.';
  end if;
end;
$$;

rollback;
