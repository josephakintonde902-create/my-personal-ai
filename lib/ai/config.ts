// Central configuration for turning study materials into a searchable
// knowledge base. Nothing here is secret; API keys are read from the
// environment in lib/ai/embeddings/provider.ts.

// The length of the vectors stored in document_chunks.embedding. It MUST match
// both the embedding model's output and the `vector(1536)` column created in
// supabase/migrations/*_create_document_chunks.sql. 1536 is the native output
// size of OpenAI's text-embedding-3-small. Changing models means a migration
// that changes the column, followed by reprocessing every material.
export const EMBEDDING_DIMENSIONS = 1536;
// The model used by each embedding provider when none is named. Both return
// vectors of EMBEDDING_DIMENSIONS: OpenAI's natively, Gemini's on request.
export const DEFAULT_EMBEDDING_MODELS = { openai: "text-embedding-3-small", gemini: "gemini-embedding-001" } as const;
export const DEFAULT_EMBEDDING_API_URL = "https://api.openai.com/v1";

export const EMBEDDING = {
  // Texts sent per API request.
  batchSize: 64,
  // Attempts per batch for rate limits and server errors.
  maxAttempts: 3,
  requestTimeoutMs: 60_000,
};

// Sizes are in tokens, estimated at CHARS_PER_TOKEN characters each. That is
// close enough for English study material and avoids shipping a tokenizer.
export const CHARS_PER_TOKEN = 4;

export const CHUNKING = {
  // Chunks are filled up to about this size...
  targetTokens: 1000,
  // ...and never exceed this one.
  maxTokens: 1200,
  // Text repeated from the end of one chunk at the start of the next, so a
  // sentence cut by a boundary is still found whole in one of them.
  overlapTokens: 150,
  // A heading starts a new chunk once the current one is at least this full.
  headingBreakTokens: 400,
};

export const PROCESSING = {
  // Above this a document is rejected instead of running up embedding costs.
  maxChunksPerMaterial: 2000,
  // A PDF page with fewer characters than this has no real text layer...
  textlessPageChars: 10,
  // ...and a PDF where more than this share of pages are like that is a scan.
  scannedPageShare: 0.5,
  // Overall budget for one material, checked between stages.
  timeoutMs: 4.5 * 60_000,
  // Guard against zip bombs in DOCX/PPTX: total size once decompressed.
  maxUnzippedBytes: 300 * 1024 * 1024,
};

// Must match the interval in public.start_material_processing: after this
// long a 'processing' material is considered abandoned and can be retried.
export const STALE_PROCESSING_MINUTES = 15;

export const RETRIEVAL = {
  defaultTopK: 8,
  maxTopK: 50,
  // Similarity is 1 - cosine distance, so 1 is identical and 0 is unrelated.
  defaultMinScore: 0.2,
  maxQueryLength: 2000,
};

export function estimateTokens(text: string) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
