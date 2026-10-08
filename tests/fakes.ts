// In-memory stand-ins for the database and the embedding service, so the
// pipeline and retrieval logic can be tested without network access.
import type { EmbeddingProvider } from "@/lib/ai/embeddings/provider";
import type { ProcessingErrorCode } from "@/lib/ai/errors";
import type { ChunkToStore, MaterialToProcess, ProcessingStore } from "@/lib/ai/processing/pipeline";
import type { RetrievedChunk, VectorRepository, VectorSearch } from "@/lib/ai/retrieval/repository";

export const TEST_DIMENSIONS = 64;

function hashWord(word: string) {
  let hash = 0;
  for (const char of word) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % TEST_DIMENSIONS;
}

// A deterministic "embedding": each word adds weight to one dimension. Texts
// that share words get similar vectors, which is enough to test ranking.
export function fakeVector(text: string) {
  const vector = new Array<number>(TEST_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) vector[hashWord(word)] += 1;
  return vector;
}

export class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "fake-embeddings";
  readonly dimensions: number = TEST_DIMENSIONS;
  calls: string[][] = [];
  // Set to make the next N batch requests fail.
  failNext = 0;

  async embedDocuments(texts: string[]) {
    this.calls.push(texts);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("provider unavailable: secret-key-123");
    }
    return texts.map(fakeVector);
  }

  async embedQuery(text: string) {
    return fakeVector(text);
  }
}

type StoredChunk = ChunkToStore & { materialId: string; subjectId: string; runId: string };

type FakeMaterial = MaterialToProcess & {
  bytes: Uint8Array;
  status: "pending" | "processing" | "ready" | "failed";
  runId: string | null;
  activeRunId: string | null;
  errorCode: ProcessingErrorCode | null;
  errorMessage: string | null;
  stats: { pageCount: number | null; wordCount: number } | null;
};

// Mirrors the rules of the real database functions: one run at a time, chunks
// of a run are invisible until it finishes, finishing swaps runs atomically,
// failing discards only the failed run.
export class FakeStore implements ProcessingStore {
  materials = new Map<string, FakeMaterial>();
  chunks: StoredChunk[] = [];
  private runCounter = 0;
  failSave = false;

  add(id: string, typeId: string, bytes: Uint8Array, subjectId = "subject-1") {
    this.materials.set(id, {
      id,
      subjectId,
      typeId,
      bytes,
      filePath: `user/${subjectId}/${id}/file.${typeId}`,
      mimeType: "",
      status: "pending",
      runId: null,
      activeRunId: null,
      errorCode: null,
      errorMessage: null,
      stats: null,
    });
    return this.materials.get(id)!;
  }

  // The chunks a search would see.
  liveChunks(materialId: string) {
    const material = this.materials.get(materialId)!;
    return this.chunks.filter((chunk) => chunk.materialId === materialId && chunk.runId === material.activeRunId);
  }

  async start(materialId: string) {
    const material = this.materials.get(materialId);
    if (!material || material.status === "processing") return null;

    material.status = "processing";
    material.errorCode = null;
    material.errorMessage = null;
    material.runId = `run-${++this.runCounter}`;
    this.chunks = this.chunks.filter((c) => c.materialId !== materialId || c.runId === material.activeRunId);
    return { runId: material.runId, material };
  }

  async download(material: MaterialToProcess) {
    return this.materials.get(material.id)!.bytes;
  }

  // The embedding model each material's chunks were last saved with.
  embeddingModels = new Map<string, string>();

  async saveChunks(material: MaterialToProcess, runId: string, chunks: ChunkToStore[], embeddingModel: string) {
    this.embeddingModels.set(material.id, embeddingModel);
    if (this.failSave) throw new Error("database unavailable");
    for (const chunk of chunks) {
      const duplicate = this.chunks.some((c) => c.materialId === material.id && c.runId === runId && c.index === chunk.index);
      if (duplicate) throw new Error("duplicate chunk position");
      this.chunks.push({ ...chunk, materialId: material.id, subjectId: material.subjectId, runId });
    }
  }

  async finish(material: MaterialToProcess, runId: string, stats: { pageCount: number | null; wordCount: number }) {
    const stored = this.materials.get(material.id)!;
    if (stored.status !== "processing" || stored.runId !== runId) throw new Error("run superseded");
    stored.status = "ready";
    stored.activeRunId = runId;
    stored.stats = stats;
    this.chunks = this.chunks.filter((c) => c.materialId !== material.id || c.runId === runId);
  }

  async fail(material: MaterialToProcess, runId: string, code: ProcessingErrorCode, message: string) {
    const stored = this.materials.get(material.id)!;
    if (stored.status !== "processing" || stored.runId !== runId) return;
    stored.status = "failed";
    stored.errorCode = code;
    stored.errorMessage = message;
    this.chunks = this.chunks.filter((c) => c.materialId !== material.id || c.runId !== runId);
  }
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

// Ranks a store's live chunks the way match_document_chunks does. Ownership
// is not modelled here; that rule lives in the database and is tested in SQL.
export class FakeVectorRepository implements VectorRepository {
  private readonly store: FakeStore;
  lastSearch: VectorSearch | null = null;

  constructor(store: FakeStore) {
    this.store = store;
  }

  async search(query: VectorSearch): Promise<RetrievedChunk[]> {
    this.lastSearch = query;
    return [...this.store.materials.keys()]
      .flatMap((materialId) => this.store.liveChunks(materialId))
      .filter((chunk) => !query.subjectId || chunk.subjectId === query.subjectId)
      .filter((chunk) => !query.materialId || chunk.materialId === query.materialId)
      .map((chunk) => ({
        chunkId: `${chunk.materialId}:${chunk.index}`,
        content: chunk.content,
        score: cosine(chunk.embedding, query.embedding),
        chunkIndex: chunk.index,
        materialId: chunk.materialId,
        materialTitle: chunk.materialId,
        materialFilename: `${chunk.materialId}.txt`,
        subjectId: chunk.subjectId,
        subjectName: chunk.subjectId,
        pageNumber: chunk.pageNumber ?? null,
        slideNumber: chunk.slideNumber ?? null,
        sectionTitle: chunk.sectionTitle ?? null,
      }))
      .filter((chunk) => chunk.score >= query.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.topK);
  }
}
