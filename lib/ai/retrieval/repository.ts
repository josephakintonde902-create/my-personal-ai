import type { SupabaseClient } from "@supabase/supabase-js";

// A chunk returned by a search, with everything needed to say where it came
// from ("According to Ocular Anatomy Lecture 1, page 14…").
export type RetrievedChunk = {
  chunkId: string;
  content: string;
  // 0–1, higher is more relevant.
  score: number;
  chunkIndex: number;
  materialId: string;
  materialTitle: string;
  materialFilename: string;
  subjectId: string;
  subjectName: string;
  pageNumber: number | null;
  slideNumber: number | null;
  sectionTitle: string | null;
};

export type VectorSearch = {
  embedding: number[];
  topK: number;
  minScore: number;
  subjectId?: string;
  materialId?: string;
  // The model that made the query vector. Only chunks embedded by the same
  // model are comparable with it.
  embeddingModel?: string;
};

// Where vectors are searched. Retrieval depends on this interface only, so a
// different vector database could replace pgvector by adding another
// implementation. Whatever the backend, results must be limited to the
// signed-in user by the backend itself, not by the caller.
export interface VectorRepository {
  search(query: VectorSearch): Promise<RetrievedChunk[]>;
}

// PostgREST's code for "no function with these parameters".
const FUNCTION_NOT_FOUND = "PGRST202";

type MatchRow = {
  chunk_id: string;
  content: string;
  similarity: number;
  chunk_index: number;
  page_number: number | null;
  slide_number: number | null;
  section_title: string | null;
  material_id: string;
  material_title: string;
  material_filename: string;
  subject_id: string;
  subject_name: string;
};

// pgvector inside the app's own Supabase database. The similarity ranking
// happens in Postgres (public.match_document_chunks); chunks are never loaded
// into JavaScript to be compared. The function derives the user from the
// session, so this class has no user id to pass and cannot ask for anyone
// else's data.
export class SupabaseVectorRepository implements VectorRepository {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async search({ embedding, topK, minScore, subjectId, materialId, embeddingModel }: VectorSearch) {
    const filters = {
      query_embedding: `[${embedding.join(",")}]`,
      match_count: topK,
      match_threshold: minScore,
      filter_subject_id: subjectId ?? null,
      filter_material_id: materialId ?? null,
    };
    let { data, error } = await this.supabase.rpc("match_document_chunks", { ...filters, filter_embedding_model: embeddingModel ?? null });
    // A database that has not had the embedding-model migration applied has
    // no such parameter. Search as before rather than not at all.
    if (error?.code === FUNCTION_NOT_FOUND) ({ data, error } = await this.supabase.rpc("match_document_chunks", filters));
    if (error) throw new Error(`match_document_chunks: ${error.code}`);

    return (data as MatchRow[]).map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      score: row.similarity,
      chunkIndex: row.chunk_index,
      materialId: row.material_id,
      materialTitle: row.material_title,
      materialFilename: row.material_filename,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      pageNumber: row.page_number,
      slideNumber: row.slide_number,
      sectionTitle: row.section_title,
    }));
  }
}
