-- Phase 4: the knowledge base.
--
-- Each processed study material is split into chunks of text. Every chunk is
-- stored with an embedding (a vector describing its meaning) so the chunks
-- most relevant to a question can be found by similarity search.

-- pgvector provides the `vector` type and distance operators.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Processing metadata on study_materials
-- ---------------------------------------------------------------------------
alter table public.study_materials
  -- When the current/last processing attempt began. Used to detect attempts
  -- that died without reporting back.
  add column processing_started_at timestamptz,
  -- Identifies the attempt in progress. Chunks are written under this id.
  add column processing_run_id uuid,
  -- The run whose chunks are live. Search only ever returns these, so chunks
  -- from an attempt that is still running (or was abandoned) stay invisible.
  add column active_run_id uuid,
  -- Machine-readable reason for a failure (see lib/ai/errors.ts);
  -- processing_error holds the matching human-readable message.
  add column processing_error_code text,
  add column processed_at timestamptz,
  -- Pages for a PDF, slides for a PPTX, null otherwise.
  add column page_count integer,
  add column word_count integer,
  add column chunk_count integer,
  -- Target for the foreign key on document_chunks, which guarantees a chunk,
  -- its material and its subject all belong to the same user.
  add constraint study_materials_id_subject_user_key unique (id, subject_id, user_id);

-- These columns are readable by the owner (table-level SELECT from Phase 3)
-- but not writable: Phase 3 granted INSERT/UPDATE on named columns only.

-- ---------------------------------------------------------------------------
-- document_chunks
-- ---------------------------------------------------------------------------
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  material_id uuid not null,
  subject_id uuid not null,
  -- The processing run that produced this chunk.
  run_id uuid not null,
  chunk_index integer not null,
  content text not null,
  -- Where the chunk starts in its source, so answers can cite it.
  page_number integer,
  slide_number integer,
  section_title text,
  token_count integer,
  -- 1536 = output size of the configured embedding model
  -- (EMBEDDING_DIMENSIONS in lib/ai/config.ts). The two must always match.
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One foreign key ties all three ids together: the material must exist, be
  -- in this subject, and be owned by this user. Deleting a material (or its
  -- subject, which deletes the material) removes its chunks.
  constraint document_chunks_material_owner_fkey
    foreign key (material_id, subject_id, user_id)
    references public.study_materials (id, subject_id, user_id) on delete cascade,

  constraint document_chunks_content_not_empty check (char_length(content) > 0),
  constraint document_chunks_chunk_index_valid check (chunk_index >= 0),
  -- A run can hold each position only once, so re-sending a batch cannot
  -- create duplicates.
  constraint document_chunks_run_position_key unique (material_id, run_id, chunk_index)
);

comment on table public.document_chunks is 'Embedded text chunks of processed study materials. Only chunks whose run_id equals the material''s active_run_id are live.';

create index document_chunks_user_subject_idx on public.document_chunks (user_id, subject_id);

-- No approximate (HNSW/IVFFlat) vector index yet, on purpose. Every search is
-- restricted to one user, so Postgres uses the index above to find that
-- user's chunks and ranks them exactly. That is fast for a student's library
-- and always returns the true best matches. An approximate index applied
-- before the per-user filter can return too few results. Revisit when single
-- users hold hundreds of thousands of chunks:
--   create index on public.document_chunks
--     using hnsw (embedding extensions.vector_cosine_ops);
--   (and set hnsw.iterative_scan in match_document_chunks)

create trigger document_chunks_set_updated_at
  before update on public.document_chunks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.document_chunks enable row level security;

create policy "Users can view their own chunks"
  on public.document_chunks for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Chunks can only be added to the caller's own material, in its real subject,
-- and only for the processing run that is currently open on that material.
-- A run's chunks do not become searchable until the run is finished.
create policy "Users can add chunks to their own materials"
  on public.document_chunks for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.study_materials m
      where m.id = document_chunks.material_id
        and m.subject_id = document_chunks.subject_id
        and m.user_id = (select auth.uid())
        and m.processing_status = 'processing'
        and m.processing_run_id = document_chunks.run_id
    )
  );

create policy "Users can delete their own chunks"
  on public.document_chunks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Chunks are never edited: reprocessing writes a new run and swaps it in.
-- So there is no UPDATE policy and no UPDATE privilege.
revoke all on public.document_chunks from anon, authenticated;
grant select, delete on public.document_chunks to authenticated;
grant insert (material_id, subject_id, run_id, chunk_index, content, page_number, slide_number, section_title, token_count, embedding)
  on public.document_chunks to authenticated;
