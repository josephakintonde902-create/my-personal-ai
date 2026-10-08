import type { SupabaseClient } from "@supabase/supabase-js";
import { MATERIALS_BUCKET } from "@/lib/library/config";
import { findTypeByExtension, findTypeByMime } from "@/lib/library/files";
import { ProcessingError, type ProcessingErrorCode } from "../errors";
import type { ChunkToStore, MaterialToProcess, ProcessingStore } from "./pipeline";

// The pipeline's link to Supabase. Every call runs as the signed-in user, so
// Row Level Security and the ownership checks inside the database functions
// apply. A material id belonging to someone else simply cannot be claimed.
// PostgREST's code for "no such column".
const COLUMN_NOT_FOUND = "PGRST204";

export class SupabaseProcessingStore implements ProcessingStore {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async start(materialId: string) {
    const { data: runId, error } = await this.supabase.rpc("start_material_processing", {
      p_material_id: materialId,
    });
    if (error) throw new Error(`start_material_processing: ${error.code}`);
    if (!runId) return null;

    const { data: row, error: loadError } = await this.supabase
      .from("study_materials")
      .select("id, subject_id, file_path, mime_type, file_extension")
      .eq("id", materialId)
      .maybeSingle();
    if (loadError || !row) throw new Error(`material load: ${loadError?.code ?? "missing"}`);

    const type = findTypeByExtension(row.file_extension ?? "") ?? findTypeByMime(row.mime_type);
    const material: MaterialToProcess = {
      id: row.id,
      subjectId: row.subject_id,
      filePath: row.file_path,
      mimeType: row.mime_type,
      typeId: type?.id ?? "unknown",
    };
    return { runId: runId as string, material };
  }

  async download(material: MaterialToProcess) {
    // The bucket is private; this succeeds only for the owner's own path.
    const { data, error } = await this.supabase.storage.from(MATERIALS_BUCKET).download(material.filePath);
    if (error || !data) throw new ProcessingError("DOWNLOAD_FAILED", error?.message ?? "no data");
    return new Uint8Array(await data.arrayBuffer());
  }

  async saveChunks(material: MaterialToProcess, runId: string, chunks: ChunkToStore[], embeddingModel: string) {
    const rows = chunks.map((chunk) => ({
      // user_id is filled in by the database from the session.
      material_id: material.id,
      subject_id: material.subjectId,
      run_id: runId,
      chunk_index: chunk.index,
      content: chunk.content,
      page_number: chunk.pageNumber ?? null,
      slide_number: chunk.slideNumber ?? null,
      section_title: chunk.sectionTitle?.slice(0, 300) ?? null,
      token_count: chunk.tokenCount,
      // pgvector's text form.
      embedding: `[${chunk.embedding.join(",")}]`,
    }));

    let { error } = await this.supabase.from("document_chunks").insert(rows.map((row) => ({ ...row, embedding_model: embeddingModel })));
    // A database that has not had the embedding-model migration applied has
    // no such column. Store the chunks as before rather than not at all.
    if (error?.code === COLUMN_NOT_FOUND) ({ error } = await this.supabase.from("document_chunks").insert(rows));
    if (error) throw new ProcessingError("VECTOR_STORAGE_FAILED", `chunk insert: ${error.code}`);
  }

  async finish(material: MaterialToProcess, runId: string, stats: { pageCount: number | null; wordCount: number }) {
    const { data: finished, error } = await this.supabase.rpc("finish_material_processing", {
      p_material_id: material.id,
      p_run_id: runId,
      p_page_count: stats.pageCount,
      p_word_count: stats.wordCount,
    });
    if (error) throw new ProcessingError("VECTOR_STORAGE_FAILED", `finish_material_processing: ${error.code}`);
    // False means a newer run took over; this run's chunks are cleaned up by it.
    if (!finished) throw new ProcessingError("PROCESSING_TIMEOUT", "run was superseded before it finished");
  }

  async fail(material: MaterialToProcess, runId: string, code: ProcessingErrorCode, message: string) {
    const { error } = await this.supabase.rpc("fail_material_processing", {
      p_material_id: material.id,
      p_run_id: runId,
      p_error_code: code,
      p_error_message: message,
    });
    if (error) throw new Error(`fail_material_processing: ${error.code}`);
  }
}
