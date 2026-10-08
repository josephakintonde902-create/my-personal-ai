-- Phase 4: processing state transitions and similarity search.
--
-- Users cannot write processing_status directly (Phase 3 column grants). These
-- functions are the only way to move a material between states. Each one acts
-- on the caller's own material only: the owner is always auth.uid(), never an
-- argument. They run as the function owner (security definer) because they
-- update columns the caller has no direct privilege on; search_path is empty
-- and every object is schema-qualified.

-- ---------------------------------------------------------------------------
-- pending/ready/failed → processing
-- ---------------------------------------------------------------------------
-- Returns a new run id, or null if the material does not belong to the caller
-- or is already being processed. An attempt older than 15 minutes is treated
-- as abandoned and can be taken over (STALE_PROCESSING_MINUTES in the app).
create function public.start_material_processing(p_material_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_run uuid := gen_random_uuid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  update public.study_materials m
     set processing_status = 'processing',
         processing_error = null,
         processing_error_code = null,
         processing_started_at = now(),
         processing_run_id = v_run
   where m.id = p_material_id
     and m.user_id = v_user
     and (
       m.processing_status <> 'processing'
       or m.processing_started_at is null
       or m.processing_started_at < now() - interval '15 minutes'
     );

  if not found then
    return null;
  end if;

  -- Clear out chunks left by attempts that never finished. The live run's
  -- chunks are kept, so the material stays searchable while it is reprocessed.
  delete from public.document_chunks c
   using public.study_materials m
   where m.id = p_material_id
     and c.material_id = m.id
     and c.user_id = v_user
     and c.run_id is distinct from m.active_run_id;

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- processing → ready
-- ---------------------------------------------------------------------------
-- In one transaction: makes the run's chunks the live set, removes the
-- previous set, and records the result. Returns false if the run is no longer
-- the one in progress (for example it was superseded by a retry), in which
-- case nothing changes.
create function public.finish_material_processing(
  p_material_id uuid,
  p_run_id uuid,
  p_page_count integer,
  p_word_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_chunks integer;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Lock the row and confirm this run is still the one in progress.
  perform 1
     from public.study_materials m
    where m.id = p_material_id
      and m.user_id = v_user
      and m.processing_status = 'processing'
      and m.processing_run_id = p_run_id
      for update;

  if not found then
    return false;
  end if;

  select count(*) into v_chunks
    from public.document_chunks c
   where c.material_id = p_material_id and c.run_id = p_run_id and c.user_id = v_user;

  -- A material is never marked ready with nothing in the knowledge base.
  if v_chunks = 0 then
    raise exception 'No chunks were stored for this run';
  end if;

  update public.study_materials m
     set processing_status = 'ready',
         active_run_id = p_run_id,
         processing_error = null,
         processing_error_code = null,
         processed_at = now(),
         page_count = p_page_count,
         word_count = p_word_count,
         chunk_count = v_chunks
   where m.id = p_material_id
     and m.user_id = v_user;

  delete from public.document_chunks c
   where c.material_id = p_material_id and c.user_id = v_user and c.run_id <> p_run_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- processing → failed
-- ---------------------------------------------------------------------------
-- Discards the failed run's chunks. Chunks from an earlier successful run are
-- kept, so a failed reprocess does not empty the knowledge base.
create function public.fail_material_processing(
  p_material_id uuid,
  p_run_id uuid,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  update public.study_materials m
     set processing_status = 'failed',
         processing_error_code = left(p_error_code, 50),
         processing_error = left(p_error_message, 500)
   where m.id = p_material_id
     and m.user_id = v_user
     and m.processing_status = 'processing'
     and m.processing_run_id = p_run_id;

  if not found then
    return false;
  end if;

  delete from public.document_chunks c
   where c.material_id = p_material_id and c.user_id = v_user and c.run_id = p_run_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Similarity search
-- ---------------------------------------------------------------------------
-- Returns the caller's chunks closest in meaning to the query embedding, with
-- the source details needed to cite them.
--
-- Ownership is not a parameter. The function runs with the caller's own
-- privileges (security invoker), so Row Level Security applies to every table
-- it reads, and it filters on auth.uid() explicitly as well. There is no
-- argument through which another user's chunks could be requested.
--
-- similarity = 1 - cosine distance: 1 means identical, 0 means unrelated.
create function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  match_threshold double precision default 0,
  filter_subject_id uuid default null,
  filter_material_id uuid default null
)
returns table (
  chunk_id uuid,
  content text,
  similarity double precision,
  chunk_index integer,
  page_number integer,
  slide_number integer,
  section_title text,
  material_id uuid,
  material_title text,
  material_filename text,
  subject_id uuid,
  subject_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.content,
    1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity,
    c.chunk_index,
    c.page_number,
    c.slide_number,
    c.section_title,
    m.id,
    m.title,
    m.original_filename,
    s.id,
    s.name
  from public.document_chunks c
  join public.study_materials m on m.id = c.material_id and m.active_run_id = c.run_id
  join public.subjects s on s.id = c.subject_id
  where c.user_id = (select auth.uid())
    and (filter_subject_id is null or c.subject_id = filter_subject_id)
    and (filter_material_id is null or c.material_id = filter_material_id)
    and 1 - (c.embedding operator(extensions.<=>) query_embedding) >= match_threshold
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

-- Callable by signed-in users only.
revoke execute on function public.start_material_processing(uuid) from public, anon;
revoke execute on function public.finish_material_processing(uuid, uuid, integer, integer) from public, anon;
revoke execute on function public.fail_material_processing(uuid, uuid, text, text) from public, anon;
revoke execute on function public.match_document_chunks(extensions.vector, integer, double precision, uuid, uuid) from public, anon;

grant execute on function public.start_material_processing(uuid) to authenticated;
grant execute on function public.finish_material_processing(uuid, uuid, integer, integer) to authenticated;
grant execute on function public.fail_material_processing(uuid, uuid, text, text) to authenticated;
grant execute on function public.match_document_chunks(extensions.vector, integer, double precision, uuid, uuid) to authenticated;
