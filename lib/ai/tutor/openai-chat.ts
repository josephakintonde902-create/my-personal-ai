import { TutorError } from "./errors";
import type { ChatMessage, TutorModel } from "./provider";

type Options = {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  // Names the service in the server log ("xai API responded 403").
  label?: string;
  // Ask for a reply that is a single JSON document, where the service
  // supports the OpenAI JSON mode.
  json?: boolean;
  // Injectable for tests.
  fetch?: typeof fetch;
};

type StreamChunk = { choices?: { delta?: { content?: unknown } }[]; error?: unknown };

// Works with OpenAI's chat completions API and with any service that copies
// its request and streaming format (POST {baseUrl}/chat/completions). xAI's
// Grok API is one of those, and is reached through this class.
export class OpenAICompatibleChat implements TutorModel {
  readonly model: string;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.model = options.model;
  }

  async streamChat(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
    const { apiKey, baseUrl, maxOutputTokens, connectTimeoutMs, responseTimeoutMs, label = "chat", json } = this.options;
    const doFetch = this.options.fetch ?? fetch;

    const body: Record<string, unknown> = { model: this.model, messages, stream: true };
    // OpenAI renamed the answer-length limit; its newer models reject the old
    // name. Services that copy the API generally still expect the old one.
    const limitName = /^https?:\/\/([^/]+\.)?openai\.com(\/|$)/i.test(baseUrl) ? "max_completion_tokens" : "max_tokens";
    body[limitName] = maxOutputTokens;
    if (json) body.response_format = { type: "json_object" };

    // One controller covers both limits: time to start answering, and time to
    // finish. `timedOut` tells a timeout apart from other failures.
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => {
      timedOut = true;
      controller.abort();
    };
    const connectTimer = setTimeout(abort, connectTimeoutMs);
    const responseTimer = setTimeout(abort, responseTimeoutMs);
    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
    };

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimers();
      throw new TutorError(timedOut ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", `${label} request failed: ${(error as Error).name}`);
    }
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      clearTimers();
      const { reason, outOfCredit } = await errorReason(response);
      // An account that is out of credit answers 429 (OpenAI) or 403 (xAI).
      // Waiting does not help and the key is not wrong, so it is reported
      // as neither "busy" nor a rejected key.
      const code = outOfCredit
        ? "PROVIDER_BILLING"
        : response.status === 401 || response.status === 403
          ? "PROVIDER_AUTH"
          : response.status === 429
            ? "PROVIDER_RATE_LIMITED"
            : response.status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "PROVIDER_ERROR";
      throw new TutorError(code, `${label} API responded ${response.status}${reason ? ` (${reason})` : ""}`);
    }

    return readDeltas(response.body, () => timedOut, clearTimers);
  }
}

// The provider's short machine-readable reason for a failure, for the server
// log: "insufficient_quota", "invalid_api_key", "model_not_found". Only the
// error's type and code are read, and only if they look like identifiers.
// The message is never kept: it can echo the request (the student's question
// and notes) or part of the key.
//
// Services shape their errors differently: OpenAI nests { error: { type,
// code, message } }, xAI sends { code, error: "message" }. Whether the
// account is out of credit is read from the message as a yes or no only.
async function errorReason(response: Response) {
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown };
    const nested = typeof body.error === "object" && body.error !== null ? (body.error as { type?: unknown; code?: unknown; message?: unknown }) : {};
    const identifiers = [nested.type, nested.code, body.code].filter(
      (value): value is string => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,59}$/i.test(value),
    );
    const reason = [...new Set(identifiers)].join(", ");
    const message = typeof body.error === "string" ? body.error : typeof nested.message === "string" ? nested.message : "";
    return { reason, outOfCredit: /quota|credit|billing|balance/i.test(`${reason} ${message}`) };
  } catch {
    return { reason: "", outOfCredit: false };
  }
}

// Reads a server-sent event stream of chat completion chunks and yields the
// text of each one.
async function* readDeltas(body: ReadableStream<Uint8Array>, timedOut: () => boolean, done: () => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (data === "[DONE]") return;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new TutorError("PROVIDER_ERROR", "chat stream reported an error");

        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text) yield text;
      }
    }
  } catch (error) {
    if (error instanceof TutorError) throw error;
    throw new TutorError(timedOut() ? "TIMEOUT" : "PROVIDER_ERROR", `chat stream failed: ${(error as Error).name}`);
  } finally {
    done();
    await reader.cancel().catch(() => {});
  }
}
