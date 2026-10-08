import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { completeChat } from "@/lib/ai/practice/generate";
import { PracticeError } from "@/lib/ai/practice/errors";
import { AnthropicChat, type ClaudeRequest, type ClaudeStream } from "@/lib/ai/tutor/anthropic-chat";
import { DEFAULT_MODELS } from "@/lib/ai/tutor/config";
import { TUTOR_ERRORS, TutorError } from "@/lib/ai/tutor/errors";
import { handleTutorChat } from "@/lib/ai/tutor/handler";
import { OpenAICompatibleChat } from "@/lib/ai/tutor/openai-chat";
import { aiConfigProblem, aiModel, aiProvider, getTutorModel, isTutorConfigured } from "@/lib/ai/tutor/provider";
import type { TutorErrorBody } from "@/lib/ai/tutor/types";
import { chatRequest, depsFor, readEvents, world } from "./tutor-fakes";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "sk-ant-test-secret";

type Event = { type: string; delta?: object };
const text = (value: string): Event => ({ type: "content_block_delta", delta: { type: "text_delta", text: value } });

// A reply the way the SDK streams it: bookkeeping events, an (empty)
// thinking block, then the text of the answer.
const REPLY: Event[] = [
  { type: "message_start" },
  { type: "content_block_start" },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } },
  { type: "content_block_delta", delta: { type: "signature_delta", signature: "abc" } },
  { type: "content_block_stop" },
  { type: "content_block_start" },
  text("Hello"),
  text(", student"),
  { type: "content_block_stop" },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

function stream(events: Event[], final: { stop_reason: string | null; stop_details?: { category?: string | null } | null } = { stop_reason: "end_turn" }, failAfter?: { count: number; error: unknown }): ClaudeStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (failAfter && i >= failAfter.count) throw failAfter.error;
        yield events[i];
      }
      if (failAfter && failAfter.count >= events.length) throw failAfter.error;
    },
    finalMessage: async () => final,
  };
}

// A stream that fails before its first event, like a request the API rejects.
const rejected = (error: unknown) => stream([], { stop_reason: null }, { count: 0, error });

const apiError = (status: number, type: string, message = `Problem with key ${SECRET}`) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message }, request_id: "req_123" }, message, new Headers({ "request-id": "req_123" }));

function claude(open: (request: ClaudeRequest) => ClaudeStream, overrides: { model?: string; effort?: "low" | "medium" | "high"; responseTimeoutMs?: number } = {}) {
  const requests: ClaudeRequest[] = [];
  const model = new AnthropicChat({
    apiKey: SECRET,
    model: "claude-sonnet-5-5",
    maxOutputTokens: 2000,
    effort: "low",
    responseTimeoutMs: 2000,
    open: (request) => {
      requests.push(request);
      return open(request);
    },
    ...overrides,
  });
  return { model, requests };
}

async function collect(reply: AsyncIterable<string>) {
  let all = "";
  for await (const piece of reply) all += piece;
  return all;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TutorError, `expected a TutorError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const names = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_API_URL", "AI_MAX_OUTPUT_TOKENS", ...Object.keys(values)];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
    run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("AI provider selection", () => {
  it("uses Claude by default", () => {
    withEnv({ AI_API_KEY: SECRET }, () => {
      assert.equal(aiProvider(), "anthropic");
      const model = getTutorModel();
      assert.ok(model instanceof AnthropicChat);
      assert.equal(model.model, DEFAULT_MODELS.anthropic);
      assert.equal(DEFAULT_MODELS.anthropic, "claude-sonnet-5-5");
    });
  });

  it("takes the model from AI_MODEL, and the provider from AI_PROVIDER", () => {
    withEnv({ AI_API_KEY: SECRET, AI_PROVIDER: "anthropic", AI_MODEL: "claude-haiku-4-5" }, () => {
      assert.equal(getTutorModel().model, "claude-haiku-4-5");
      assert.equal(aiModel(), "claude-haiku-4-5");
    });
    withEnv({ AI_API_KEY: SECRET, AI_PROVIDER: " Claude " }, () => assert.ok(getTutorModel() instanceof AnthropicChat));
  });

  it("only uses the OpenAI-compatible provider when asked to", () => {
    withEnv({ AI_API_KEY: "sk-openai", AI_PROVIDER: "openai" }, () => {
      const model = getTutorModel();
      assert.ok(model instanceof OpenAICompatibleChat);
      assert.equal(model.model, DEFAULT_MODELS.openai);
    });
    // With AI_PROVIDER=anthropic, a leftover AI_API_URL is simply ignored.
    withEnv({ AI_API_KEY: SECRET, AI_PROVIDER: "anthropic", AI_API_URL: "https://api.openai.com/v1" }, () => assert.ok(getTutorModel() instanceof AnthropicChat));
  });

  it("fails cleanly with no API key or an unknown provider", () => {
    withEnv({}, () => {
      assert.equal(isTutorConfigured(), false);
      assert.throws(() => getTutorModel(), (error) => error instanceof TutorError && error.code === "NOT_CONFIGURED" && Boolean(error.detail?.startsWith("AI_API_KEY is not set")));
    });
    withEnv({ AI_API_KEY: SECRET, AI_PROVIDER: "gemini" }, () => {
      assert.throws(() => getTutorModel(), (error) => {
        assert.ok(error instanceof TutorError && error.code === "NOT_CONFIGURED");
        assert.ok(!`${error.message} ${error.detail}`.includes(SECRET));
        return true;
      });
    });
  });
});

describe("AI settings left over from another provider", () => {
  const notConfigured = (expected: RegExp) => (error: unknown) => {
    assert.ok(error instanceof TutorError && error.code === "NOT_CONFIGURED");
    assert.match(error.detail ?? "", expected);
    assert.ok(!`${error.message} ${error.detail}`.includes("sk-proj-abc123"));
    return true;
  };

  it("never sends an OpenAI key to Claude, or falls back to OpenAI silently", () => {
    // The Phase 5 and 6 settings, unchanged: an OpenAI key, model and URL, and no AI_PROVIDER.
    withEnv({ AI_API_KEY: "sk-proj-abc123", AI_MODEL: "gpt-4o-mini", AI_API_URL: "https://api.openai.com/v1" }, () => {
      assert.equal(isTutorConfigured(), false);
      assert.throws(() => getTutorModel(), notConfigured(/AI_API_URL is set but AI_PROVIDER is not/));
    });
    withEnv({ AI_API_KEY: "sk-proj-abc123", AI_PROVIDER: "anthropic" }, () => {
      assert.throws(() => getTutorModel(), notConfigured(/looks like an OpenAI key/));
    });
    withEnv({ AI_API_KEY: SECRET, AI_PROVIDER: "anthropic", AI_MODEL: "gpt-4o-mini" }, () => {
      assert.throws(() => getTutorModel(), notConfigured(/names an OpenAI model/));
    });
  });

  it("still allows the OpenAI-compatible provider when it is chosen explicitly", () => {
    withEnv({ AI_PROVIDER: "openai", AI_API_KEY: "sk-proj-abc123", AI_MODEL: "gpt-4o-mini", AI_API_URL: "https://api.openai.com/v1" }, () => {
      assert.equal(aiConfigProblem(), null);
      assert.ok(getTutorModel() instanceof OpenAICompatibleChat);
    });
  });
});

describe("Claude provider: request", () => {
  const conversation = [
    { role: "system" as const, content: "You are Ari." },
    { role: "user" as const, content: "What is refraction?" },
    { role: "assistant" as const, content: "The bending of light." },
    { role: "user" as const, content: "Explain that more simply." },
  ];

  it("moves the system prompt to its own field and keeps the conversation in order", () => {
    const { model } = claude(() => stream(REPLY));
    const params = model.buildParams(conversation);

    assert.equal(params.model, "claude-sonnet-5-5");
    assert.equal(params.system, "You are Ari.");
    assert.deepEqual(params.messages, [
      { role: "user", content: "What is refraction?" },
      { role: "assistant", content: "The bending of light." },
      { role: "user", content: "Explain that more simply." },
    ]);
    // Nothing in the OpenAI request shape, and no key in the body.
    assert.ok(!("stream" in params) && !("max_completion_tokens" in params));
    assert.ok(!JSON.stringify(params).includes(SECRET));
  });

  it("sets the answer length and effort in a way each model accepts", () => {
    // A model that thinks first gets room for that on top of the answer.
    const sonnet = claude(() => stream(REPLY)).model.buildParams(conversation);
    assert.equal(sonnet.max_tokens, 5000);
    assert.deepEqual(sonnet.output_config, { effort: "low" });
    assert.ok(!("thinking" in sonnet) && !("temperature" in sonnet));

    // Claude Haiku 4.5 takes neither an effort setting nor thinking by default.
    const haiku = claude(() => stream(REPLY), { model: "claude-haiku-4-5" }).model.buildParams(conversation);
    assert.equal(haiku.max_tokens, 2000);
    assert.ok(!("output_config" in haiku));

    const medium = claude(() => stream(REPLY), { model: "claude-opus-5-5", effort: "medium" }).model.buildParams(conversation);
    assert.deepEqual(medium.output_config, { effort: "medium" });
  });

  it("omits the system field when there are no instructions", () => {
    const params = claude(() => stream(REPLY)).model.buildParams([{ role: "user", content: "Hi" }]);
    assert.ok(!("system" in params));
  });

  it("asks for a fallback on declined requests only from models that support it", async () => {
    const sonnet = claude(() => stream(REPLY));
    await collect(await sonnet.model.streamChat(conversation));
    assert.deepEqual(sonnet.requests.map((r) => r.refusalFallback), [true]);

    const haiku = claude(() => stream(REPLY), { model: "claude-haiku-4-5" });
    await collect(await haiku.model.streamChat(conversation));
    assert.deepEqual(haiku.requests.map((r) => r.refusalFallback), [false]);
  });
});

describe("Claude provider: response", () => {
  const ask = [{ role: "user" as const, content: "Hi" }];

  it("returns only the text of the answer, in order", async () => {
    const { model } = claude(() => stream(REPLY));
    assert.equal(await collect(await model.streamChat(ask)), "Hello, student");
  });

  it("works through the practice code path as one complete reply", async () => {
    const { model } = claude(() => stream([text('{"verdict":"correct",'), text('"feedback":"Right."}')]));
    assert.equal(await completeChat(model, ask, "EVALUATION_FAILED"), '{"verdict":"correct","feedback":"Right."}');
  });

  it("answers a tutor question end to end, with the instructions sent as the system prompt", async () => {
    const w = world();
    const { model, requests } = claude(() => stream(REPLY));
    const response = await handleTutorChat(chatRequest({ message: "What is refraction?" }), { ...depsFor(w, USER), getModel: () => model });

    const events = await readEvents(response);
    assert.deepEqual(events.map((e) => e.type), ["start", "delta", "delta", "done"]);
    assert.equal(w.db.messages[1].content, "Hello, student");
    assert.ok(String(requests[0].params.system).startsWith("You are Ari, a patient AI study tutor"));
    assert.ok(String(requests[0].params.system).includes("STUDY MATERIAL CONTEXT"));
    assert.deepEqual(requests[0].params.messages, [{ role: "user", content: "What is refraction?" }]);
  });

  it("treats a declined request as a failure, not as an answer", async () => {
    const { model } = claude(() => stream([text("I can't")], { stop_reason: "refusal", stop_details: { category: "general_harms" } }));
    const error = await failure(collect(await model.streamChat(ask)));
    assert.equal(error.code, "PROVIDER_REFUSED");
    assert.equal(error.detail, "anthropic refusal (general_harms)");
  });

  it("reports a reply it cannot read as a provider error", async () => {
    // The stream breaks in a way that is not an API error.
    const broken = claude(() => stream([text("Par")], { stop_reason: null }, { count: 1, error: new SyntaxError(`Unexpected token in ${SECRET}`) }));
    const error = await failure(collect(await broken.model.streamChat(ask)));
    assert.equal(error.code, "PROVIDER_ERROR");
    assert.equal(error.detail, "anthropic reply could not be read: SyntaxError");

    // A reply with no text at all yields nothing, which the tutor reports as a failure.
    const empty = claude(() => stream([{ type: "message_start" }, { type: "message_stop" }]));
    assert.equal(await collect(await empty.model.streamChat(ask)), "");
    const response = await handleTutorChat(chatRequest({ message: "Hello?" }), { ...depsFor(world(), USER), getModel: () => empty.model });
    const last = (await readEvents(response)).at(-1)!;
    assert.deepEqual(last, { type: "error", code: "PROVIDER_ERROR", message: TUTOR_ERRORS.PROVIDER_ERROR.message });
  });
});

describe("Claude provider: errors", () => {
  const ask = [{ role: "user" as const, content: "Hi" }];

  it("maps each kind of failure to a clean application error, before anything is streamed", async () => {
    const cases: [unknown, string, string][] = [
      [apiError(401, "authentication_error"), "PROVIDER_AUTH", "anthropic 401 authentication_error request req_123"],
      [apiError(403, "permission_error"), "PROVIDER_AUTH", "anthropic 403 permission_error request req_123"],
      [apiError(402, "billing_error"), "PROVIDER_BILLING", "anthropic 402 billing_error request req_123"],
      [apiError(429, "rate_limit_error"), "PROVIDER_RATE_LIMITED", "anthropic 429 rate_limit_error request req_123"],
      [apiError(404, "not_found_error"), "PROVIDER_UNAVAILABLE", "anthropic 404 not_found_error request req_123 (check AI_MODEL)"],
      [apiError(500, "api_error"), "PROVIDER_UNAVAILABLE", "anthropic 500 api_error request req_123"],
      [apiError(529, "overloaded_error"), "PROVIDER_UNAVAILABLE", "anthropic 529 overloaded_error request req_123"],
      [new Anthropic.APIConnectionError({ message: `connect failed ${SECRET}` }), "PROVIDER_UNAVAILABLE", "anthropic could not be reached"],
      [new Anthropic.APIConnectionTimeoutError(), "TIMEOUT", "anthropic request timed out"],
    ];

    for (const [thrown, code, detail] of cases) {
      const { model } = claude(() => rejected(thrown), { model: "claude-haiku-4-5" });
      const error = await failure(model.streamChat(ask));
      assert.equal(error.code, code);
      assert.equal(error.detail, detail);
      // Neither the key nor the provider's message reaches the student or the log.
      assert.ok(!`${error.message} ${error.detail}`.includes(SECRET));
      assert.ok(!error.message.toLowerCase().includes("anthropic"));
    }
  });

  it("shows students one calm message for a bad key, an empty balance and an outage", async () => {
    for (const thrown of [apiError(401, "authentication_error"), apiError(402, "billing_error"), apiError(529, "overloaded_error")]) {
      const { model } = claude(() => rejected(thrown), { model: "claude-haiku-4-5" });
      const response = await handleTutorChat(chatRequest({ message: "What is refraction?" }), { ...depsFor(world(), USER), getModel: () => model });
      const body = (await response.json()) as TutorErrorBody;

      assert.equal(response.status, 503);
      assert.ok(body.error.startsWith("Ari's AI service is temporarily unavailable."));
      assert.ok(!JSON.stringify(body).includes(SECRET) && !JSON.stringify(body).includes("req_123"));
    }
  });

  it("reports quiz and flashcard generation failures the same way", async () => {
    const cases = [[apiError(402, "billing_error"), "AI_UNAVAILABLE"], [apiError(401, "authentication_error"), "AI_UNAVAILABLE"], [apiError(429, "rate_limit_error"), "PROVIDER_BUSY"], [apiError(400, "invalid_request_error"), "GENERATION_FAILED"]] as const;
    for (const [thrown, code] of cases) {
      const { model } = claude(() => rejected(thrown), { model: "claude-haiku-4-5" });
      await assert.rejects(completeChat(model, ask, "GENERATION_FAILED"), (error) => {
        assert.ok(error instanceof PracticeError);
        assert.equal(error.code, code);
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
    }
  });

  it("retries once without the fallback option if the request is rejected with it", async () => {
    let calls = 0;
    const recovering = claude(() => (++calls === 1 ? rejected(apiError(400, "invalid_request_error")) : stream(REPLY)));

    assert.equal(await collect(await recovering.model.streamChat(ask)), "Hello, student");
    assert.deepEqual(recovering.requests.map((r) => r.refusalFallback), [true, false]);

    // A request that is simply invalid is still reported, after that one retry.
    const invalid = claude(() => rejected(apiError(400, "invalid_request_error")));
    const error = await failure(invalid.model.streamChat(ask));
    assert.equal(error.code, "PROVIDER_ERROR");
    assert.equal(invalid.requests.length, 2);
  });

  it("maps a failure that happens partway through an answer", async () => {
    const { model } = claude(() => stream([text("Partial")], { stop_reason: null }, { count: 1, error: apiError(529, "overloaded_error") }));
    const reply = await model.streamChat(ask);
    const error = await failure(collect(reply));
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
  });

  it("gives up on a provider that does not answer in time", async () => {
    const { model } = claude(
      ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())));
        },
        finalMessage: async () => ({ stop_reason: null }),
      }),
      { responseTimeoutMs: 20 },
    );
    assert.equal((await failure(model.streamChat(ask))).code, "TIMEOUT");
  });
});
