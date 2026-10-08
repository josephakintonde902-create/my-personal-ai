import { ApiError, GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import { TutorError } from "./errors";
import type { ChatMessage, ModelEffort, TutorModel } from "./provider";

// What a Gemini model accepts differs by model, and GEMINI_MODEL is free
// text, so the request is shaped from the model's name rather than assumed.
//
// Models that think before answering. Their thinking counts toward
// maxOutputTokens, so they are given room for it on top of the answer length
// the app asked for.
const THINKS = /^gemini-(2\.5|[3-9])/;
// Models that take a thinking level (Gemini 3 and later).
const TAKES_THINKING_LEVEL = /^gemini-[3-9]/;
const THINKING_LEVELS: Record<ModelEffort, string> = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
const THINKING_HEADROOM_TOKENS = 3000;
// Reasons Gemini gives for stopping that mean "declined", not "finished".
const DECLINED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

// The parts of a streamed Gemini response this provider reads.
export type GeminiChunk = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export type GeminiRequest = GenerateContentParameters;

type Options = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  effort?: ModelEffort;
  // Ask for a reply that is a single JSON document.
  json?: boolean;
  responseTimeoutMs: number;
  // Injectable for tests. By default requests go through the official SDK.
  open?: (request: GeminiRequest) => Promise<AsyncIterable<GeminiChunk>>;
};

// Gemini, through Google's Gen AI SDK. Translates the app's provider-neutral
// request (a list of system/user/assistant messages) into Gemini's shape and
// its streamed reply back into plain text pieces.
export class GeminiChat implements TutorModel {
  readonly model: string;
  private readonly options: Options;
  private client: GoogleGenAI | null = null;

  constructor(options: Options) {
    this.options = options;
    this.model = options.model;
  }

  // Gemini takes the system prompt as a separate instruction, and calls the
  // assistant's turns "model".
  buildRequest(messages: ChatMessage[], signal: AbortSignal, withThinkingLevel = true): GeminiRequest {
    const { maxOutputTokens, effort, json } = this.options;
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");

    const config: NonNullable<GeminiRequest["config"]> = {
      maxOutputTokens: maxOutputTokens + (THINKS.test(this.model) ? THINKING_HEADROOM_TOKENS : 0),
      abortSignal: signal,
    };
    if (system) config.systemInstruction = system;
    if (json) config.responseMimeType = "application/json";
    if (withThinkingLevel && effort && TAKES_THINKING_LEVEL.test(this.model)) {
      config.thinkingConfig = { thinkingLevel: THINKING_LEVELS[effort] as NonNullable<NonNullable<GeminiRequest["config"]>["thinkingConfig"]>["thinkingLevel"] };
    }

    return {
      model: this.model,
      contents: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
      config,
    };
  }

  private open(request: GeminiRequest): Promise<AsyncIterable<GeminiChunk>> {
    if (this.options.open) return this.options.open(request);
    this.client ??= new GoogleGenAI({ apiKey: this.options.apiKey });
    return this.client.models.generateContentStream(request);
  }

  async streamChat(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
    // Whether this model is sent a thinking level at all.
    const sendsThinkingLevel = Boolean(this.options.effort && TAKES_THINKING_LEVEL.test(this.model));
    let withThinkingLevel = true;
    let retriedOutage = false;

    while (true) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.responseTimeoutMs);

      try {
        const request = this.buildRequest(messages, controller.signal, withThinkingLevel);
        // Resolves once Gemini has accepted the request, so a rejected key,
        // an exhausted quota or an unknown model fails here, before anything
        // is streamed to the student.
        const stream = await this.open(request);
        const chunks = stream[Symbol.asyncIterator]();
        const first = await chunks.next();
        return readText(chunks, first, () => timedOut, () => clearTimeout(timer));
      } catch (error) {
        clearTimeout(timer);
        const failure = toTutorError(error, timedOut);
        // A model that does not take a thinking level rejects the request
        // with it. Send the plain request once before giving up.
        if (sendsThinkingLevel && withThinkingLevel && failure.code === "PROVIDER_ERROR" && error instanceof ApiError && error.status === 400) {
          withThinkingLevel = false;
          continue;
        }
        // Gemini is briefly overloaded fairly often; one more try is cheap.
        if (!retriedOutage && error instanceof ApiError && error.status >= 500) {
          retriedOutage = true;
          await new Promise((resolve) => setTimeout(resolve, 600));
          continue;
        }
        throw failure;
      }
    }
  }
}

// Yields the answer's text as it arrives. The model's thinking is not part
// of the answer and is skipped.
async function* readText(chunks: AsyncIterator<GeminiChunk>, first: IteratorResult<GeminiChunk>, timedOut: () => boolean, done: () => void) {
  try {
    for (let next = first; !next.done; next = await chunks.next()) {
      const chunk = next.value;
      if (chunk.promptFeedback?.blockReason) throw new TutorError("PROVIDER_REFUSED", `gemini blocked the request (${chunk.promptFeedback.blockReason})`);

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text && !part.thought) yield part.text;
      }
      // A decline arrives as a normal response with this finish reason.
      if (candidate?.finishReason && DECLINED.has(candidate.finishReason)) {
        throw new TutorError("PROVIDER_REFUSED", `gemini stopped (${candidate.finishReason})`);
      }
    }
  } catch (error) {
    throw toTutorError(error, timedOut());
  } finally {
    done();
    await chunks.return?.().catch(() => {});
  }
}

// The machine-readable reason in a Gemini error ("API_KEY_INVALID",
// "RESOURCE_EXHAUSTED"). Only identifiers are taken. The message itself is
// never kept: it can echo the request, which holds the student's question
// and notes.
function reasonOf(error: ApiError) {
  // On a streamed request the error body arrives as JSON inside a JSON
  // string, with its quotes escaped; dropping the backslashes reads both.
  const found = [...error.message.replace(/\\+/g, "").matchAll(/"(?:reason|status)"\s*:\s*"([A-Z][A-Z_]{2,40})"/g)].map((match) => match[1]);
  return [...new Set(found)].join(", ");
}

// Maps a failure to one of the app's own errors, keeping only the status and
// the reason code for the server log.
export function toTutorError(error: unknown, timedOut: boolean) {
  if (error instanceof TutorError) return error;
  if (timedOut) return new TutorError("TIMEOUT", "gemini request timed out");

  if (error instanceof ApiError) {
    const reason = reasonOf(error);
    const detail = `gemini ${error.status}${reason ? ` ${reason}` : ""}`;
    // Gemini reports an invalid key as a 400, not a 401.
    if (error.status === 401 || error.status === 403 || /API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED|UNAUTHENTICATED/.test(reason)) {
      return new TutorError("PROVIDER_AUTH", detail);
    }
    // Both "slow down" and a used-up free quota arrive as 429.
    if (error.status === 429) return new TutorError("PROVIDER_RATE_LIMITED", detail);
    if (error.status === 404) return new TutorError("PROVIDER_UNAVAILABLE", `${detail} (check GEMINI_MODEL)`);
    if (error.status >= 500) return new TutorError("PROVIDER_UNAVAILABLE", detail);
    return new TutorError("PROVIDER_ERROR", detail);
  }

  const name = (error as Error)?.name ?? "unknown";
  if (name === "AbortError") return new TutorError("TIMEOUT", "gemini request was aborted");
  // A failed fetch is a TypeError; anything else is a reply that could not be read.
  if (name === "TypeError") return new TutorError("PROVIDER_UNAVAILABLE", "gemini could not be reached");
  return new TutorError("PROVIDER_ERROR", `gemini reply could not be read: ${name}`);
}
