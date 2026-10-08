import { chunkDocument, embeddingInput, type Chunk } from "../chunking/chunker";
import { PROCESSING } from "../config";
import { cleanDocument, countCharacters, countWords } from "../documents/clean";
import { extractDocument } from "../documents/extract";
import type { OcrProvider } from "../documents/ocr";
import type { ExtractedDocument } from "../documents/types";
import { embedInBatches, type EmbeddingProvider } from "../embeddings/provider";
import { ProcessingError, toProcessingError, type ProcessingErrorCode } from "../errors";

// What the pipeline needs to know about a material.
export type MaterialToProcess = {
  id: string;
  subjectId: string;
  filePath: string;
  mimeType: string;
  // Validated type id: "pdf", "docx", "pptx", "ppt", "txt", "png", "jpg", "webp".
  typeId: string;
};

export type ChunkToStore = Chunk & { embedding: number[] };

// Everything the pipeline does to the outside world goes through this
// interface. The real implementation talks to Supabase as the signed-in user
// (lib/ai/processing/supabase-store.ts); tests use an in-memory one.
export interface ProcessingStore {
  // Claims the material and marks it 'processing'. Returns null when it does
  // not exist, belongs to someone else, or is already being processed.
  start(materialId: string): Promise<{ runId: string; material: MaterialToProcess } | null>;
  download(material: MaterialToProcess): Promise<Uint8Array>;
  // Stores chunks for this run. They stay invisible to search until finish().
  // `embeddingModel` names the model that made the chunks' vectors.
  saveChunks(material: MaterialToProcess, runId: string, chunks: ChunkToStore[], embeddingModel: string): Promise<void>;
  // Atomically makes this run's chunks the material's only chunks and marks it 'ready'.
  finish(material: MaterialToProcess, runId: string, stats: { pageCount: number | null; wordCount: number }): Promise<void>;
  // Discards this run's chunks and marks the material 'failed'.
  fail(material: MaterialToProcess, runId: string, code: ProcessingErrorCode, message: string): Promise<void>;
}

export type PipelineDependencies = {
  store: ProcessingStore;
  embeddings: EmbeddingProvider;
  ocr: OcrProvider | null;
  now?: () => number;
};

export type ProcessingResult =
  | { status: "ready"; chunkCount: number; wordCount: number }
  | { status: "failed"; code: ProcessingErrorCode }
  // Nothing was done: not found, not owned, or another run is in progress.
  | { status: "skipped" };

async function readDocument(material: MaterialToProcess, bytes: Uint8Array, ocr: OcrProvider | null) {
  let document: ExtractedDocument;
  try {
    document = await extractDocument({ bytes, typeId: material.typeId, mimeType: material.mimeType });
  } catch (error) {
    throw toProcessingError(error, "EXTRACTION_FAILED");
  }

  if (!document.needsOcr) return document;

  // Scanned pages or an image. Without a provider this is reported honestly
  // rather than passing off an empty document as processed.
  if (!ocr) throw new ProcessingError("OCR_UNAVAILABLE", `no OCR provider for ${material.typeId}`);
  try {
    return await ocr.recognize({ bytes, mimeType: material.mimeType });
  } catch (error) {
    throw toProcessingError(error, "OCR_FAILED");
  }
}

// Runs one material through the whole pipeline:
//
//   claim → download → extract (→ OCR) → clean → chunk → embed → store → ready
//
// Any failure marks the material 'failed' with a safe message. The chunks of
// a previous successful run are left untouched until the new run finishes, so
// reprocessing never leaves a material with no chunks or with two sets.
export async function processMaterial(materialId: string, deps: PipelineDependencies): Promise<ProcessingResult> {
  const { store, embeddings, ocr } = deps;
  const now = deps.now ?? Date.now;

  const claim = await store.start(materialId);
  if (!claim) return { status: "skipped" };

  const { runId, material } = claim;
  const deadline = now() + PROCESSING.timeoutMs;
  const checkTime = () => {
    if (now() > deadline) throw new ProcessingError("PROCESSING_TIMEOUT");
  };

  try {
    let bytes: Uint8Array;
    try {
      bytes = await store.download(material);
    } catch (error) {
      throw toProcessingError(error, "DOWNLOAD_FAILED");
    }
    checkTime();

    const document = cleanDocument(await readDocument(material, bytes, ocr));
    checkTime();

    if (countCharacters(document) === 0) throw new ProcessingError("EMPTY_DOCUMENT");

    const chunks = chunkDocument(document);
    if (chunks.length === 0) throw new ProcessingError("EMPTY_DOCUMENT");
    if (chunks.length > PROCESSING.maxChunksPerMaterial) {
      throw new ProcessingError("DOCUMENT_TOO_LARGE", `${chunks.length} chunks`);
    }

    try {
      await embedInBatches(embeddings, chunks.map(embeddingInput), async (start, vectors) => {
        checkTime();
        const batch = vectors.map((embedding, offset) => ({ ...chunks[start + offset], embedding }));
        try {
          await store.saveChunks(material, runId, batch, embeddings.model);
        } catch (error) {
          throw toProcessingError(error, "VECTOR_STORAGE_FAILED");
        }
      });
    } catch (error) {
      throw toProcessingError(error, "EMBEDDING_FAILED");
    }

    const wordCount = countWords(document);
    try {
      await store.finish(material, runId, { pageCount: document.pageCount ?? null, wordCount });
    } catch (error) {
      throw toProcessingError(error, "VECTOR_STORAGE_FAILED");
    }

    return { status: "ready", chunkCount: chunks.length, wordCount };
  } catch (error) {
    const failure = toProcessingError(error);
    // The detail is for operators; only the code and safe message are stored.
    console.error("[processing] material failed", { materialId, code: failure.code, detail: failure.detail });

    try {
      await store.fail(material, runId, failure.code, failure.message);
    } catch (storeError) {
      console.error("[processing] could not record failure", { materialId, detail: (storeError as Error).message });
    }
    return { status: "failed", code: failure.code };
  }
}
