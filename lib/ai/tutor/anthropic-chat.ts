import Anthropic from "@anthropic-ai/sdk";
import { TutorError } from "./errors";
import type { ChatMessage, ModelEffort, TutorModel } from "./provider";

// What a Claude model accepts differs by model, and AI_MODEL is free text, so
// the request is shaped from the model's name rather than assumed.
//
// Models that take output_config.effort (Claude Haiku 4.5 rejects it).
const TAKES_EFFORT = /^claude-(fable|mythos|opus-(5|4-[5-8])|sonnet-(5|4-6))/;
// Models that think before answering unless told otherwise. Their thinking
// counts toward max_tokens, so they are given room for it on top of the
// answer length the app asked for.
const THINKS_BY_DEFAULT = /^claude-(fable|mythos|opus-5|sonnet-5)/;
// Models whose safety classifiers can decline a request, and which support
// re-running a declined request on another model inside the same call.
const HAS_REFUSAL_FALLBACK = /^claude-(fable-5-1|opus-5|sonnet-5-5)/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const THINKING_HEADROOM_TOKENS = 3000;

// Only text deltas are read; every other event is passed over.
type StreamEvent = { type: string; delta?: object };
type FinalMessage = { stop_reason: string | null; stop_details?: { category?: string | null } | null };

// The part of the SDK's message stream this provider uses.
export type ClaudeStream = AsyncIterable<StreamEvent> & { finalMessage(): Promise<FinalMessage> };

export type ClaudeRequest = {
  params: Anthropic.MessageStreamParams;
  // Ask the API to retry a declined request on its recommended fallback model.
  refusalFallback: boolean;
  signal: AbortSignal;
};

type Options = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  effort?: ModelEffort;
  responseTimeoutMs: number;
  // Injectable for tests. By default requests go through the official SDK.
  open?: (request: ClaudeRequest) => ClaudeStream;
};

// Claude, through Anthropic's Messages API and official SDK. Translates the
// app's provider-neutral request (a list of system/user/assistant messages)
// into Anthropic's shape and its streamed reply back into plain text pieces.
export class AnthropicChat implements TutorModel {
  readonly model: string;
  private readonly options: Options;
  private client: Anthropic | null = null;

  constructor(options: Options) {
    this.options = options;
    this.model = options.model;
  }

  // Anthropic takes the system prompt as its own field, not as a message.
  buildParams(messages: ChatMessage[]): Anthropic.MessageStreamParams {
    const { maxOutputTokens, effort } = this.options;
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const conversation = messages
      .filter((message): message is ChatMessage & { role: "user" | "assistant" } => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));

    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: maxOutputTokens + (THINKS_BY_DEFAULT.test(this.model) ? THINKING_HEADROOM_TOKENS : 0),
      messages: conversation,
    };
    if (system) params.system = system;
    if (effort && TAKES_EFFORT.test(this.model)) params.output_config = { effort };
    return params;
  }

  private open({ params, refusalFallback, signal }: ClaudeRequest): ClaudeStream {
    if (this.options.open) return this.options.open({ params, refusalFallback, signal });

    const client = (this.client ??= new Anthropic({ apiKey: this.options.apiKey, maxRetries: 2, timeout: this.options.responseTimeoutMs }));
    if (refusalFallback) {
      type BetaParams = Parameters<typeof client.beta.messages.stream>[0];
      return client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" } as BetaParams, { signal });
    }
    return client.messages.stream(params, { signal });
  }

  async streamChat(messages: ChatMessage[]): Promise<AsyncIterable<string>> {
    const params = this.buildParams(messages);
    let refusalFallback = HAS_REFUSAL_FALLBACK.test(this.model);

    while (true) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.responseTimeoutMs);

      try {
        const stream = this.open({ params, refusalFallback, signal: controller.signal });
        const events = stream[Symbol.asyncIterator]();
        // The first event arrives once Anthropic has accepted the request, so
        // a rejected key, an empty balance or an unknown model fails here,
        // before anything is streamed to the student.
        const first = await events.next();
        return readText(stream, events, first, () => timedOut, () => clearTimeout(timer));
      } catch (error) {
        clearTimeout(timer);
        // The fallback option is a beta feature. If the request is rejected
        // with it, send the plain request once before giving up.
        if (refusalFallback && error instanceof Anthropic.BadRequestError) {
          refusalFallback = false;
          continue;
        }
        throw toTutorError(error, timedOut);
      }
    }
  }
}

function textOf(event: StreamEvent) {
  if (event.type !== "content_block_delta") return "";
  const delta = event.delta as { type?: string; text?: string } | undefined;
  return delta?.type === "text_delta" ? (delta.text ?? "") : "";
}

// Yields the answer's text as it arrives. Thinking and other block types are
// not part of the answer and are skipped.
async function* readText(
  stream: ClaudeStream,
  events: AsyncIterator<StreamEvent>,
  first: IteratorResult<StreamEvent>,
  timedOut: () => boolean,
  done: () => void,
) {
  try {
    for (let next = first; !next.done; next = await events.next()) {
      const text = textOf(next.value);
      if (text) yield text;
    }

    const final = await stream.finalMessage();
    // A decline is a normal response with this stop reason, not an error
    // status. Any text before it is not a usable answer.
    if (final.stop_reason === "refusal") {
      throw new TutorError("PROVIDER_REFUSED", `anthropic refusal (${final.stop_details?.category ?? "uncategorised"})`);
    }
  } catch (error) {
    throw toTutorError(error, timedOut());
  } finally {
    done();
    await events.return?.().catch(() => {});
  }
}

// Maps an SDK failure to one of the app's own errors. Only the status, the
// error type and the request id are kept for the server log. The message is
// not: it can echo the request, which holds the student's question and notes.
function toTutorError(error: unknown, timedOut: boolean) {
  if (error instanceof TutorError) return error;

  const describe = (apiError: InstanceType<typeof Anthropic.APIError>) =>
    `anthropic ${apiError.status ?? "network"} ${apiError.type ?? apiError.name}${apiError.requestID ? ` request ${apiError.requestID}` : ""}`;

  if (timedOut || error instanceof Anthropic.APIConnectionTimeoutError) return new TutorError("TIMEOUT", "anthropic request timed out");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new TutorError("PROVIDER_AUTH", describe(error));
  }
  if (error instanceof Anthropic.RateLimitError) return new TutorError("PROVIDER_RATE_LIMITED", describe(error));
  // An unknown model and a model the account cannot use look the same.
  if (error instanceof Anthropic.NotFoundError) return new TutorError("PROVIDER_UNAVAILABLE", `${describe(error)} (check AI_MODEL)`);
  if (error instanceof Anthropic.APIConnectionError) return new TutorError("PROVIDER_UNAVAILABLE", "anthropic could not be reached");
  if (error instanceof Anthropic.APIError) {
    if (error.type === "billing_error" || error.status === 402) return new TutorError("PROVIDER_BILLING", describe(error));
    if (typeof error.status === "number" && error.status >= 500) return new TutorError("PROVIDER_UNAVAILABLE", describe(error));
    return new TutorError("PROVIDER_ERROR", describe(error));
  }
  // Anything else is a reply the SDK could not make sense of.
  return new TutorError("PROVIDER_ERROR", `anthropic reply could not be read: ${(error as Error)?.name ?? "unknown"}`);
}
