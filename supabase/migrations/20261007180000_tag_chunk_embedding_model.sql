-- Record which embedding model made each chunk's vector.
--
-- Ari can now create embeddings with more than one provider (OpenAI or
-- Gemini). Both produce 1536-dimension vectors, so the column and every
-- existing vector stay exactly as they are: nothing is deleted or rewritten.
--
-- But vectors from different models cannot be compared with each other. A
-- question embedded by one model, searched against chunks embedded by
-- another, returns arbitrary passages with confident-looking scores. This
-- migration tags every chunk with its model and lets search ask for chunks
-- from one model only.
--
-- After switching EMBEDDING_PROVIDER, materials processed with the previous
-- model are still stored and simply stop matching. "Reprocess" on a material
-- embeds it again with the model now in use.

alter table public.document_chunks
  add column embedding_model text,
  add constraint document_chunks_embedding_model_length check (char_length(embedding_model) between 1 and 100);

-- Every chunk stored before this migration was made by the only model the
-- app could use until now.
update public.document_chunks
   set embedding_model = 'text-embedding-3-small'
 where embedding_model is null;

-- Signed-in users may set it when adding chunks to their own materials. The
-- insert policy from Phase 4 still decides which chunks they may add.
grant insert (embedding_model) on public.document_chunks to authenticated;

-- ---------------------------------------------------------------------------
-- Similarity search, limited to one embedding model when asked
-- ---------------------------------------------------------------------------
-- Replaces the Phase 4 function with one more optional argument. Everything
-- else is unchanged: it runs with the caller's own privileges (security
-- invoker), so Row Level Security applies to every table it reads, and it
-- filters on auth.uid() explicitly as well. There is still no argument
-- through which another user's chunks could be requested.
drop function public.match_document_chunks(extensions.vector, integer, double precision, uuid, uuid);

create function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 8,
  match_threshold double precision default 0,
  filter_subject_id uuid default null,
  filter_material_id uuid default null,
  -- The model that made query_embedding. Null searches every chunk.
  filter_embedding_model text default null
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
    and (filter_embedding_model is null or c.embedding_model = filter_embedding_model)
    and 1 - (c.embedding operator(extensions.<=>) query_embedding) >= match_threshold
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

revoke execute on function public.match_document_chunks(extensions.vector, integer, double precision, uuid, uuid, text) from public, anon;
grant execute on function public.match_document_chunks(extensions.vector, integer, double precision, uuid, uuid, text) to authenticated;
