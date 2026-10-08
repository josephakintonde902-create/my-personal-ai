import { DEFAULT_EMBEDDING_API_URL, DEFAULT_EMBEDDING_MODELS, EMBEDDING, EMBEDDING_DIMENSIONS } from "../config";
import { ProcessingError } from "../errors";
import { GeminiEmbeddings } from "./gemini";
import { OpenAICompatibleEmbeddings } from "./openai";

// Turns text into vectors. The rest of the app depends only on this
// interface, so the provider can be changed without touching the pipeline or
// retrieval code.
export interface EmbeddingProvider {
  // Also the tag stored with every chunk, so that search only compares
  // vectors made by the same model.
  readonly model: string;
  // Length of every vector returned. Must equal the database column's size.
  readonly dimensions: number;
  // Texts per request, if the provider needs fewer than the default.
  readonly batchSize?: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export const EMBEDDING_PROVIDERS = ["openai", "gemini"] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

const env = (name: string) => process.env[name]?.trim() ?? "";

// Server-only settings. None of these use the NEXT_PUBLIC_ prefix, so they
// are never sent to the browser. Embeddings are chosen independently of the
// AI provider that writes Ari's answers.
//
//   EMBEDDING_PROVIDER   optional   "openai" (default) or "gemini"
//
//   openai   EMBEDDING_API_KEY   EMBEDDING_MODEL          EMBEDDING_API_URL
//   gemini   GEMINI_API_KEY      GEMINI_EMBEDDING_MODEL
//
// Both produce 1536-dimension vectors, matching the database column. Gemini's
// has a free tier, so Ari can run without OpenAI credit.
//
// Changing provider does not delete anything, but materials processed with
// one model are not searchable with another until they are reprocessed.
export function embeddingProviderName(): EmbeddingProviderName | null {
  const value = env("EMBEDDING_PROVIDER").toLowerCase() || "openai";
  if (value === "google") return "gemini";
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value) ? (value as EmbeddingProviderName) : null;
}

function embeddingKeyName(provider: EmbeddingProviderName) {
  return provider === "gemini" ? "GEMINI_API_KEY" : "EMBEDDING_API_KEY";
}

export function embeddingModel(provider: EmbeddingProviderName) {
  return (provider === "gemini" ? env("GEMINI_EMBEDDING_MODEL") : env("EMBEDDING_MODEL")) || DEFAULT_EMBEDDING_MODELS[provider];
}

// What is wrong with the embedding settings, or null if they can be used.
export function embeddingConfigProblem(): string | null {
  const provider = embeddingProviderName();
  if (!provider) return `EMBEDDING_PROVIDER is not one of: ${EMBEDDING_PROVIDERS.join(", ")}`;
  const keyName = embeddingKeyName(provider);
  if (!env(keyName)) return `${keyName} is not set (needed because the embedding provider is ${provider})`;
  return null;
}

export function isEmbeddingConfigured() {
  return embeddingConfigProblem() === null;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const problem = embeddingConfigProblem();
  if (problem) throw new ProcessingError("EMBEDDING_NOT_CONFIGURED", problem);
  const provider = embeddingProviderName()!;

  const shared = {
    apiKey: env(embeddingKeyName(provider)),
    model: embeddingModel(provider),
    dimensions: EMBEDDING_DIMENSIONS,
    maxAttempts: EMBEDDING.maxAttempts,
    requestTimeoutMs: EMBEDDING.requestTimeoutMs,
  };

  if (provider === "gemini") return new GeminiEmbeddings(shared);
  return new OpenAICompatibleEmbeddings({ ...shared, baseUrl: (env("EMBEDDING_API_URL") || DEFAULT_EMBEDDING_API_URL).replace(/\/$/, "") });
}

// Embeds texts in batches, reporting each finished batch so the caller can
// store it straight away. One request per batch, not one per text.
export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  onBatch: (start: number, vectors: number[][]) => Promise<void>,
  batchSize: number = provider.batchSize ?? EMBEDDING.batchSize,
) {
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const vectors = await provider.embedDocuments(batch);

    // A wrong-sized vector would be rejected by the database anyway; checking
    // here gives a clear error instead of a storage failure.
    if (vectors.length !== batch.length || vectors.some((vector) => vector.length !== provider.dimensions)) {
      throw new ProcessingError(
        "EMBEDDING_FAILED",
        `expected ${batch.length} vectors of ${provider.dimensions} dimensions from ${provider.model}`,
      );
    }
    await onBatch(start, vectors);
  }
}
