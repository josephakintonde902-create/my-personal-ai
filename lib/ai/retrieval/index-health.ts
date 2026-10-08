import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedChunk } from "./repository";

// What is actually in the knowledge base for a student, as opposed to what a
// material's status says. Used to tell apart "nothing uploaded", "marked
// ready but nothing indexed" and "indexed, but the search cannot reach it",
// which all look the same from an empty search result.
//
// Every query here runs as the signed-in user under Row Level Security, and
// filters on that user's id as well. There is no way to name another user.

export type IndexScope = { subjectId?: string | null; materialId?: string | null };

export type IndexHealth = {
  // Materials in scope that show "Ready for Ari".
  readyMaterials: number;
  // Passages stored for them.
  chunks: number;
  // Of those, the ones made by the embedding model in use. Only these can be
  // found by a similarity search: vectors from different models cannot be
  // compared, so the search ignores the rest.
  searchableChunks: number;
};

// PostgREST and Postgres codes for "there is no such column": a database
// that has not had the embedding-model migration applied.
const NO_SUCH_COLUMN = new Set(["42703", "PGRST204"]);
const MAX_SCANNED_CHUNKS = 5000;

type LightChunk = { id: string; material_id: string; run_id: string; chunk_index: number; embedding_model?: string | null };
type MaterialRow = { id: string; title: string; original_filename: string; subject_id: string; active_run_id: string | null; chunk_count: number | null };

export async function inspectIndex(supabase: SupabaseClient, userId: string, scope: IndexScope, embeddingModel: string | null): Promise<IndexHealth> {
  const count = { count: "exact" as const, head: true };
  const materialCount = () => {
    let query = supabase.from("study_materials").select("id", count).eq("user_id", userId).eq("processing_status", "ready");
    if (scope.subjectId) query = query.eq("subject_id", scope.subjectId);
    if (scope.materialId) query = query.eq("id", scope.materialId);
    return query;
  };
  const chunkCount = (model: string | null) => {
    let query = supabase.from("document_chunks").select("id", count).eq("user_id", userId);
    if (scope.subjectId) query = query.eq("subject_id", scope.subjectId);
    if (scope.materialId) query = query.eq("material_id", scope.materialId);
    if (model) query = query.eq("embedding_model", model);
    return query;
  };

  const [materials, chunks, searchable] = await Promise.all([materialCount(), chunkCount(null), embeddingModel ? chunkCount(embeddingModel) : null]);
  const failed = materials.error ?? chunks.error;
  if (failed) throw new Error(`index inspection: ${failed.code}`);

  let searchableChunks = 0;
  if (searchable) {
    // Without the column, the search does not filter by model either, so
    // every chunk is as searchable as it ever was.
    if (searchable.error && NO_SUCH_COLUMN.has(searchable.error.code)) searchableChunks = chunks.count ?? 0;
    else if (searchable.error) throw new Error(`index inspection: ${searchable.error.code}`);
    else searchableChunks = searchable.count ?? 0;
  }
  return { readyMaterials: materials.count ?? 0, chunks: chunks.count ?? 0, searchableChunks };
}

async function loadScope(supabase: SupabaseClient, userId: string, scope: IndexScope, withModel: boolean) {
  let materialQuery = supabase
    .from("study_materials")
    .select("id, title, original_filename, subject_id, active_run_id, chunk_count")
    .eq("user_id", userId)
    .eq("processing_status", "ready")
    .limit(1000);
  if (scope.subjectId) materialQuery = materialQuery.eq("subject_id", scope.subjectId);
  if (scope.materialId) materialQuery = materialQuery.eq("id", scope.materialId);

  const chunkQuery = (columns: string) => {
    let query = supabase.from("document_chunks").select(columns).eq("user_id", userId);
    if (scope.subjectId) query = query.eq("subject_id", scope.subjectId);
    if (scope.materialId) query = query.eq("material_id", scope.materialId);
    return query.order("material_id").order("chunk_index").limit(MAX_SCANNED_CHUNKS);
  };

  const columns = "id, material_id, run_id, chunk_index";
  const [materials, first] = await Promise.all([materialQuery, chunkQuery(withModel ? `${columns}, embedding_model` : columns)]);
  let chunks = first;
  if (withModel && chunks.error && NO_SUCH_COLUMN.has(chunks.error.code)) chunks = await chunkQuery(columns);
  const failed = materials.error ?? chunks.error;
  if (failed) throw new Error(`index scan: ${failed.code}`);

  const materialById = new Map((materials.data as MaterialRow[]).map((material) => [material.id, material]));
  // Only the live run of a ready material counts. Chunks of a run that is
  // still being written, or was abandoned, are not part of the knowledge base.
  const live = (chunks.data as unknown as LightChunk[]).filter((chunk) => materialById.get(chunk.material_id)?.active_run_id === chunk.run_id);
  return { materialById, live };
}

// Reads passages straight from the index, in reading order and spread evenly
// across everything in scope. No similarity is involved: nothing is ranked
// against a question, so no vectors are compared and it does not matter which
// embedding model made them.
//
// This is how an open request ("a quiz on this lecture") is served when the
// similarity search comes back empty although the material is indexed.
export async function browseChunks(supabase: SupabaseClient, userId: string, scope: IndexScope, limit: number): Promise<RetrievedChunk[]> {
  const { materialById, live } = await loadScope(supabase, userId, scope, false);
  if (live.length === 0) return [];

  const chosen = live.length <= limit ? live : Array.from({ length: limit }, (_, index) => live[Math.floor((index * live.length) / limit)]);
  const subjectIds = [...new Set(chosen.map((chunk) => materialById.get(chunk.material_id)!.subject_id))];

  const [rows, subjects] = await Promise.all([
    supabase
      .from("document_chunks")
      .select("id, content, chunk_index, page_number, slide_number, section_title, material_id, subject_id")
      .eq("user_id", userId)
      .in("id", chosen.map((chunk) => chunk.id)),
    supabase.from("subjects").select("id, name").eq("user_id", userId).in("id", subjectIds),
  ]);
  const failed = rows.error ?? subjects.error;
  if (failed) throw new Error(`index read: ${failed.code}`);

  const subjectNames = new Map((subjects.data as { id: string; name: string }[]).map((subject) => [subject.id, subject.name]));
  type Row = { id: string; content: string; chunk_index: number; page_number: number | null; slide_number: number | null; section_title: string | null; material_id: string; subject_id: string };
  return (rows.data as Row[])
    .map((row): RetrievedChunk => {
      const material = materialById.get(row.material_id)!;
      return {
        chunkId: row.id,
        content: row.content,
        // Not a relevance score: these were not ranked against anything.
        score: 0,
        chunkIndex: row.chunk_index,
        materialId: row.material_id,
        materialTitle: material.title,
        materialFilename: material.original_filename,
        subjectId: row.subject_id,
        subjectName: subjectNames.get(row.subject_id) ?? "",
        pageNumber: row.page_number,
        slideNumber: row.slide_number,
        sectionTitle: row.section_title,
      };
    })
    .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.chunkIndex - b.chunkIndex);
}

export type MaterialIndexReport = {
  id: string;
  title: string;
  // The number recorded on the material when it was processed.
  recordedChunks: number | null;
  // What is really in the index for it now.
  indexedChunks: number;
  searchableChunks: number;
  // The model each of its chunks is tagged with ("untagged" for none).
  embeddingModels: string[];
};

// One line per ready material: is it really indexed, and can the search in
// use reach it?
export async function reportMaterials(supabase: SupabaseClient, userId: string, embeddingModel: string | null): Promise<MaterialIndexReport[]> {
  const { materialById, live } = await loadScope(supabase, userId, {}, true);
  // A database without the column has no tags, and its search has no filter.
  const tagged = live.some((chunk) => chunk.embedding_model !== undefined);

  return [...materialById.values()].map((material) => {
    const own = live.filter((chunk) => chunk.material_id === material.id);
    return {
      id: material.id,
      title: material.title,
      recordedChunks: material.chunk_count,
      indexedChunks: own.length,
      searchableChunks: !tagged ? own.length : own.filter((chunk) => embeddingModel !== null && chunk.embedding_model === embeddingModel).length,
      embeddingModels: [...new Set(own.map((chunk) => chunk.embedding_model ?? "untagged"))],
    };
  });
}
