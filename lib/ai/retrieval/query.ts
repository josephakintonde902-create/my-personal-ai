import { isUuid } from "@/lib/library/files";
import { RETRIEVAL } from "../config";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { RetrievedChunk, VectorRepository } from "./repository";

export type KnowledgeBaseQuery = {
  query: string;
  // Limit the search to one subject and/or one material.
  subjectId?: string;
  materialId?: string;
  topK?: number;
  minScore?: number;
};

export class KnowledgeBaseError extends Error {
  readonly code: "UNAUTHENTICATED" | "INVALID_QUERY" | "NOT_CONFIGURED" | "SEARCH_FAILED";

  constructor(code: KnowledgeBaseError["code"], message: string) {
    super(message);
    this.name = "KnowledgeBaseError";
    this.code = code;
  }
}

// The steps of a search, independent of where embeddings and vectors come
// from: validate, embed the question, ask the vector store for the closest
// chunks. Kept free of server-only imports so it can be tested with stand-ins.
export async function searchWith(
  { query, subjectId, materialId, topK, minScore }: KnowledgeBaseQuery,
  embeddings: EmbeddingProvider,
  repository: VectorRepository,
): Promise<RetrievedChunk[]> {
  const text = typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new KnowledgeBaseError("INVALID_QUERY", "Enter something to search for.");
  if (text.length > RETRIEVAL.maxQueryLength) {
    throw new KnowledgeBaseError("INVALID_QUERY", `Searches can be up to ${RETRIEVAL.maxQueryLength} characters.`);
  }
  if ((subjectId !== undefined && !isUuid(subjectId)) || (materialId !== undefined && !isUuid(materialId))) {
    throw new KnowledgeBaseError("INVALID_QUERY", "That subject or material isn't valid.");
  }

  const requested = Number.isFinite(topK) ? Math.trunc(topK as number) : RETRIEVAL.defaultTopK;
  const limit = Math.min(Math.max(requested, 1), RETRIEVAL.maxTopK);
  const threshold = Number.isFinite(minScore) ? (minScore as number) : RETRIEVAL.defaultMinScore;

  const embedding = await embeddings.embedQuery(text);
  return repository.search({ embedding, topK: limit, minScore: threshold, subjectId, materialId, embeddingModel: embeddings.model });
}
