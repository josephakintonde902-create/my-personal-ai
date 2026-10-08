import { ProcessingError } from "../errors";
import type { EmbeddingProvider } from "./provider";

type Options = {
  apiKey: string;
  model: string;
  baseUrl: string;
  dimensions: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  // Injectable for tests.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

type EmbeddingResponse = { data?: { index: number; embedding: number[] }[] };

// Works with OpenAI's embeddings API and with any service that copies its
// request and response format (POST {baseUrl}/embeddings).
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embedDocuments(texts: string[]) {
    if (texts.length === 0) return [];
    return this.request(texts);
  }

  async embedQuery(text: string) {
    const [vector] = await this.request([text]);
    return vector;
  }

  private async request(input: string[]): Promise<number[][]> {
    const { apiKey, baseUrl, maxAttempts, requestTimeoutMs } = this.options;
    const doFetch = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    const body: Record<string, unknown> = { model: this.model, input, encoding_format: "float" };
    // OpenAI's v3 models can return shorter vectors on request. Asking for the
    // configured size keeps the model and the database column in agreement.
    if (this.model.startsWith("text-embedding-3")) body.dimensions = this.dimensions;

    let lastDetail = "no attempt made";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let retryable = true;
      try {
        const response = await doFetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });

        if (response.ok) {
          const json = (await response.json()) as EmbeddingResponse;
          if (!Array.isArray(json.data) || json.data.length !== input.length) {
            throw new ProcessingError("EMBEDDING_FAILED", "embedding response had an unexpected shape");
          }
          return [...json.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
        }

        // Only the status is kept. Response bodies can echo request content
        // and are not written to logs or the database.
        lastDetail = `embedding API responded ${response.status}`;
        retryable = response.status === 429 || response.status >= 500;
      } catch (error) {
        if (error instanceof ProcessingError) throw error;
        lastDetail = `embedding request failed: ${(error as Error).name}`;
      }

      if (!retryable) break;
      if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
    }

    throw new ProcessingError("EMBEDDING_FAILED", lastDetail);
  }
}
