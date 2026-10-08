import { ApiError, GoogleGenAI } from "@google/genai";
import { ProcessingError } from "../errors";
import type { EmbeddingProvider } from "./provider";

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export type GeminiEmbedRequest = { model: string; texts: string[]; taskType: TaskType; dimensions: number; signal: AbortSignal };

type Options = {
  apiKey: string;
  model: string;
  dimensions: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  // Injectable for tests. By default requests go through the official SDK.
  embed?: (request: GeminiEmbedRequest) => Promise<number[][]>;
  sleep?: (ms: number) => Promise<void>;
};

// Gemini's text-embedding limit is 2,048 tokens per text. Chunks are well
// under that by the app's own estimate; this guards the rare dense one.
const MAX_INPUT_CHARS = 7000;

// Scales a vector to length 1. Gemini only returns unit-length vectors at
// its full size; at a reduced size (as here) they must be normalised so that
// similarity scores mean what the rest of the app expects.
export function normalize(vector: number[]) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length > 0 ? vector.map((value) => value / length) : vector;
}

// Embeddings from Google's Gemini API, which has a free tier. The model
// returns vectors at the size asked for, so they fit the database's existing
// 1536-dimension column with no migration.
//
// Vectors from different embedding models cannot be compared with each
// other. Each stored chunk is tagged with the model that made it, and search
// only considers chunks made by the model in use.
export class GeminiEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  // Small batches keep each request inside the free tier's per-minute limit.
  readonly batchSize = 16;
  private readonly options: Options;
  private client: GoogleGenAI | null = null;

  constructor(options: Options) {
    this.options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embedDocuments(texts: string[]) {
    if (texts.length === 0) return [];
    return this.request(texts, "RETRIEVAL_DOCUMENT");
  }

  async embedQuery(text: string) {
    const [vector] = await this.request([text], "RETRIEVAL_QUERY");
    return vector;
  }

  private async embed(request: GeminiEmbedRequest): Promise<number[][]> {
    if (this.options.embed) return this.options.embed(request);

    this.client ??= new GoogleGenAI({ apiKey: this.options.apiKey });
    const response = await this.client.models.embedContent({
      model: request.model,
      contents: request.texts,
      config: { taskType: request.taskType, outputDimensionality: request.dimensions, abortSignal: request.signal },
    });
    return (response.embeddings ?? []).map((embedding) => embedding.values ?? []);
  }

  private async request(input: string[], taskType: TaskType): Promise<number[][]> {
    const { maxAttempts, requestTimeoutMs } = this.options;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const texts = input.map((text) => text.slice(0, MAX_INPUT_CHARS));

    let lastDetail = "no attempt made";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let retryable = true;
      try {
        const vectors = await this.embed({ model: this.model, texts, taskType, dimensions: this.dimensions, signal: AbortSignal.timeout(requestTimeoutMs) });
        if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== this.dimensions)) {
          throw new ProcessingError("EMBEDDING_FAILED", "gemini embedding response had an unexpected shape");
        }
        return vectors.map(normalize);
      } catch (error) {
        if (error instanceof ProcessingError) throw error;
        // Only the status is kept. Messages can echo request content and are
        // not written to logs or the database.
        if (error instanceof ApiError) {
          lastDetail = `gemini embedding API responded ${error.status}`;
          retryable = error.status === 429 || error.status >= 500;
        } else {
          lastDetail = `gemini embedding request failed: ${(error as Error).name}`;
        }
      }

      if (!retryable) break;
      // The free tier's limits reset every minute, so waits grow quickly.
      if (attempt < maxAttempts) await sleep(2000 * 2 ** (attempt - 1));
    }

    throw new ProcessingError("EMBEDDING_FAILED", lastDetail);
  }
}
