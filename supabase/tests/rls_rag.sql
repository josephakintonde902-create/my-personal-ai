-- Knowledge base check: chunk ownership, processing state rules, and vector
-- search isolation.
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up
-- and the Phase 4 migrations have been applied. It impersonates each user the
-- same way the API does, creates test subjects, materials and chunks, and
-- raises an error on the first rule that leaks. Everything is rolled back.
--
-- Embeddings here are synthetic: e1, e2 and e3 are vectors pointing along
-- three different axes, so e1 is identical to e1 (similarity 1) and unrelated
-- to e2 and e3 (similarity 0). That makes ranking and filtering exact. It
-- tests the database rules, not the quality of a real embedding model.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  subject_a uuid;
  subject_a2 uuid;
  subject_b uuid;
  material_a uuid := gen_random_uuid();
  material_a2 uuid := gen_random_uuid();
  material_b uuid := gen_random_uuid();
  run_a uuid;
  run_a2 uuid;
  run_b uuid;
  run_retry uuid;
  e1 extensions.vector;
  e2 extensions.vector;
  e3 extensions.vector;
  n int;
  ok boolean;
  top_content text;
  top_similarity double precision;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.document_chunks'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.document_chunks';
  end if;

  select array_agg(case when g = 1 then 1 else 0 end order by g)::extensions.vector into e1 from generate_series(1, 1536) g;
  select array_agg(case when g = 2 then 1 else 0 end order by g)::extensions.vector into e2 from generate_series(1, 1536) g;
  select array_agg(case when g = 3 then 1 else 0 end order by g)::extensions.vector into e3 from generate_series(1, 1536) g;

  -- ------------------------------------------------------------------ user B
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('RAG test B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_b, subject_b, 'B private notes', 'b.pdf', user_b || '/' || subject_b || '/' || material_b || '/b.pdf', 'application/pdf', 10, 'pdf');

  run_b := public.start_material_processing(material_b);
  insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, page_number, embedding)
  values (material_b, subject_b, run_b, 0, 'B SECRET: exam answers', 1, e1);
  ok := public.finish_material_processing(material_b, run_b, 1, 4);
  if not ok then raise exception 'FAIL: user B could not finish processing their own material'; end if;

  -- ------------------------------------------------------------------ user A
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('RAG test A ' || gen_random_uuid()) returning id into subject_a;
  insert into public.subjects (name) values ('RAG test A2 ' || gen_random_uuid()) returning id into subject_a2;
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_a, subject_a, 'A optics notes', 'a.pdf', user_a || '/' || subject_a || '/' || material_a || '/a.pdf', 'application/pdf', 10, 'pdf');
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_a2, subject_a2, 'A biology slides', 'a2.pptx', user_a || '/' || subject_a2 || '/' || material_a2 || '/a2.pptx', 'application/pdf', 10, 'pptx');

  -- Chunks cannot be added to a material that is not being processed.
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_a, subject_a, gen_random_uuid(), 0, 'not processing', e1);
    raise exception 'FAIL: a chunk was added outside a processing run';
  exception when insufficient_privilege then null;
  end;

  -- Starting marks the material as processing; a second start is refused.
  run_a := public.start_material_processing(material_a);
  if run_a is null then raise exception 'FAIL: user A could not start processing their own material'; end if;
  if (select processing_status from public.study_materials where id = material_a) <> 'processing' then
    raise exception 'FAIL: starting did not mark the material as processing';
  end if;
  if public.start_material_processing(material_a) is not null then
    raise exception 'FAIL: a material could be claimed twice at the same time';
  end if;

  insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, page_number, section_title, embedding)
  values
    (material_a, subject_a, run_a, 0, 'A: refraction bends light', 14, 'Refraction', e1),
    (material_a, subject_a, run_a, 1, 'A: lenses focus light', 15, 'Lenses', e2);

  if (select user_id from public.document_chunks where material_id = material_a limit 1) <> user_a then
    raise exception 'FAIL: a new chunk is not owned by the user who created it';
  end if;

  -- The same position cannot be written twice in one run.
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_a, subject_a, run_a, 0, 'duplicate position', e1);
    raise exception 'FAIL: a duplicate chunk position was accepted';
  exception when unique_violation then null;
  end;

  -- A cannot attach chunks to B's material, to B's subject, to the wrong
  -- subject, to another run, or under B's name.
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_b, subject_b, run_b, 5, 'intruder', e1);
    raise exception 'FAIL: user A attached a chunk to user B''s material';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_a, subject_b, run_a, 5, 'intruder', e1);
    raise exception 'FAIL: user A attached a chunk to user B''s subject';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_a, subject_a2, run_a, 5, 'wrong subject', e1);
    raise exception 'FAIL: a chunk was filed under a subject its material is not in';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
    values (material_a, subject_a, gen_random_uuid(), 5, 'wrong run', e1);
    raise exception 'FAIL: a chunk was added under a run that is not in progress';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.document_chunks (user_id, material_id, subject_id, run_id, chunk_index, content, embedding)
    values (user_b, material_a, subject_a, run_a, 5, 'forged owner', e1);
    raise exception 'FAIL: user A created a chunk owned by user B';
  exception when insufficient_privilege then null;
  end;

  -- Chunks of an unfinished run are not searchable.
  select count(*) into n from public.match_document_chunks(e1, 10, 0);
  if n <> 0 then raise exception 'FAIL: chunks were searchable before their run finished'; end if;

  ok := public.finish_material_processing(material_a, run_a, 20, 8);
  if not ok then raise exception 'FAIL: user A could not finish processing'; end if;
  if (select (processing_status, chunk_count, page_count, word_count) from public.study_materials where id = material_a)
     is distinct from ('ready'::text, 2, 20, 8) then
    raise exception 'FAIL: finishing did not record status and counts';
  end if;

  run_a2 := public.start_material_processing(material_a2);
  insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, slide_number, embedding)
  values (material_a2, subject_a2, run_a2, 0, 'A: mitochondria make energy', 7, e3);
  perform public.finish_material_processing(material_a2, run_a2, 12, 4);

  -- ----------------------------------------------------------- vector search
  -- B's chunk has exactly the same embedding as A's best match. If ownership
  -- leaked anywhere, it would appear here.
  select count(*) into n from public.match_document_chunks(e1, 50, 0) where content like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user A''s search returned user B''s chunk'; end if;

  select count(*) into n from public.match_document_chunks(e1, 50, 0);
  if n <> 3 then raise exception 'FAIL: user A should find their own 3 chunks, found %', n; end if;

  -- Ranking and source details.
  select m.content, m.similarity into top_content, top_similarity from public.match_document_chunks(e1, 1, 0) m;
  if top_content <> 'A: refraction bends light' or top_similarity < 0.999 then
    raise exception 'FAIL: the closest chunk was not ranked first (got "%", %)', top_content, top_similarity;
  end if;
  if not exists (
    select 1 from public.match_document_chunks(e1, 1, 0) m
    where m.material_id = material_a and m.material_title = 'A optics notes' and m.material_filename = 'a.pdf'
      and m.subject_id = subject_a and m.subject_name like 'RAG test A %'
      and m.page_number = 14 and m.section_title = 'Refraction' and m.slide_number is null
  ) then
    raise exception 'FAIL: search results are missing source details';
  end if;

  -- Threshold.
  select count(*) into n from public.match_document_chunks(e1, 50, 0.5);
  if n <> 1 then raise exception 'FAIL: the similarity threshold did not filter results (% rows)', n; end if;

  -- Subject and material filters.
  select count(*) into n from public.match_document_chunks(e1, 50, 0, subject_a2);
  if n <> 1 then raise exception 'FAIL: the subject filter returned % rows', n; end if;
  if (select slide_number from public.match_document_chunks(e1, 50, 0, subject_a2)) <> 7 then
    raise exception 'FAIL: the subject filter returned the wrong chunk';
  end if;
  select count(*) into n from public.match_document_chunks(e1, 50, 0, null, material_a);
  if n <> 2 then raise exception 'FAIL: the material filter returned % rows', n; end if;

  -- Asking for B's subject or material by id returns nothing.
  select count(*) into n from public.match_document_chunks(e1, 50, 0, subject_b);
  if n <> 0 then raise exception 'FAIL: filtering by user B''s subject returned rows'; end if;
  select count(*) into n from public.match_document_chunks(e1, 50, 0, null, material_b);
  if n <> 0 then raise exception 'FAIL: filtering by user B''s material returned rows'; end if;

  -- ------------------------------------------------- direct access to chunks
  select count(*) into n from public.document_chunks where material_id = material_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s chunks'; end if;

  delete from public.document_chunks where material_id = material_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s chunks'; end if;

  begin
    update public.document_chunks set content = 'edited' where material_id = material_a;
    raise exception 'FAIL: chunks can be edited';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------- processing functions on B's material
  if public.start_material_processing(material_b) is not null then
    raise exception 'FAIL: user A could start processing user B''s material';
  end if;
  if public.fail_material_processing(material_b, run_b, 'UNKNOWN', 'x') then
    raise exception 'FAIL: user A could fail user B''s material';
  end if;
  if public.finish_material_processing(material_b, run_b, 1, 1) then
    raise exception 'FAIL: user A could finish user B''s material';
  end if;
  if (select processing_status from public.study_materials where id = material_a) <> 'ready' then
    raise exception 'FAIL: those attempts changed user A''s own material';
  end if;

  -- ------------------------------------------------------------ reprocessing
  run_retry := public.start_material_processing(material_a);
  if run_retry is null then raise exception 'FAIL: a ready material could not be reprocessed'; end if;

  -- The previous chunks stay searchable while the new run is in progress.
  select count(*) into n from public.match_document_chunks(e1, 50, 0, null, material_a);
  if n <> 2 then raise exception 'FAIL: reprocessing hid the existing chunks (% rows)', n; end if;

  insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
  values (material_a, subject_a, run_retry, 0, 'A: rewritten notes', e1);

  -- A failure discards only the failed run and records a safe message.
  ok := public.fail_material_processing(material_a, run_retry, 'EMBEDDING_FAILED', 'We could not prepare this material.');
  if not ok then raise exception 'FAIL: could not record a processing failure'; end if;
  if (select (processing_status, processing_error_code) from public.study_materials where id = material_a)
     is distinct from ('failed'::text, 'EMBEDDING_FAILED'::text) then
    raise exception 'FAIL: the failure was not recorded';
  end if;
  select count(*) into n from public.document_chunks where material_id = material_a;
  if n <> 2 then raise exception 'FAIL: a failed run left % chunks (expected the 2 previous ones)', n; end if;

  -- A successful retry replaces the old chunks: no duplicates remain.
  run_retry := public.start_material_processing(material_a);
  insert into public.document_chunks (material_id, subject_id, run_id, chunk_index, content, embedding)
  values (material_a, subject_a, run_retry, 0, 'A: rewritten notes', e1);
  perform public.finish_material_processing(material_a, run_retry, 20, 3);

  select count(*) into n from public.document_chunks where material_id = material_a;
  if n <> 1 then raise exception 'FAIL: reprocessing left % chunks (expected 1)', n; end if;
  if (select (processing_status, chunk_count, processing_error) from public.study_materials where id = material_a)
     is distinct from ('ready'::text, 1, null::text) then
    raise exception 'FAIL: the retry did not leave the material ready';
  end if;

  -- A run that has been superseded cannot finish.
  if public.finish_material_processing(material_a2, gen_random_uuid(), 1, 1) then
    raise exception 'FAIL: an unknown run could finish a material';
  end if;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.document_chunks;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read chunks'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.match_document_chunks(e1, 50, 0);
    raise exception 'FAIL: signed-out visitors can call the search function';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.start_material_processing(material_a);
    raise exception 'FAIL: signed-out visitors can start processing';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------------------------------ cascade
  perform set_config('role', 'postgres', true);
  delete from public.study_materials where id = material_a;
  select count(*) into n from public.document_chunks where material_id = material_a;
  if n <> 0 then raise exception 'FAIL: deleting a material did not remove its chunks'; end if;

  delete from public.subjects where id = subject_a2;
  select count(*) into n from public.document_chunks where material_id = material_a2;
  if n <> 0 then raise exception 'FAIL: deleting a subject did not remove its chunks'; end if;

  raise notice 'PASS: chunks, processing state and vector search are isolated between users.';
end;
$$;

rollback;
