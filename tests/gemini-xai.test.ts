import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "@google/genai";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/config";
import { GeminiEmbeddings, normalize, type GeminiEmbedRequest } from "@/lib/ai/embeddings/gemini";
import { OpenAICompatibleEmbeddings } from "@/lib/ai/embeddings/openai";
import { embeddingConfigProblem, embedInBatches, getEmbeddingProvider, isEmbeddingConfigured } from "@/lib/ai/embeddings/provider";
import { ProcessingError } from "@/lib/ai/errors";
import { PracticeError } from "@/lib/ai/practice/errors";
import { generateDeck } from "@/lib/ai/practice/flashcard-service";
import { completeChat } from "@/lib/ai/practice/generate";
import { answerQuestion, generateQuiz, startAttempt } from "@/lib/ai/practice/quiz-service";
import { processMaterial } from "@/lib/ai/processing/pipeline";
import { searchWith } from "@/lib/ai/retrieval/query";
import { AnthropicChat } from "@/lib/ai/tutor/anthropic-chat";
import { DEFAULT_MODELS } from "@/lib/ai/tutor/config";
import { TutorError } from "@/lib/ai/tutor/errors";
import { GeminiChat, type GeminiChunk, type GeminiRequest } from "@/lib/ai/tutor/gemini-chat";
import { handleTutorChat } from "@/lib/ai/tutor/handler";
import { OpenAICompatibleChat } from "@/lib/ai/tutor/openai-chat";
import { AI_PROVIDERS, aiConfigProblem, aiModel, aiProvider, getTutorModel, isTutorConfigured, type ChatMessage, type TutorModel } from "@/lib/ai/tutor/provider";
import type { TutorErrorBody } from "@/lib/ai/tutor/types";
import { FakeEmbeddings, FakeStore, FakeVectorRepository } from "./fakes";
import { card, mcq, practiceDeps, practiceWorld, shortAnswer, trueFalse } from "./practice-fakes";
import { chatRequest, chunk, depsFor, readEvents, world } from "./tutor-fakes";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// Shaped like real keys so the tests can check they never leak. Not real.
const GEMINI_KEY = "AIzaSyTEST-not-a-real-key-000000000000";
const XAI_KEY = "xai-TESTnotARealKey0000000000000000000000";

const conversation: ChatMessage[] = [
  { role: "system", content: "You are Ari." },
  { role: "user", content: "What is refraction?" },
  { role: "assistant", content: "The bending of light." },
  { role: "user", content: "Explain that more simply." },
];

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
  const names = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_API_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "XAI_API_KEY", "XAI_MODEL", "XAI_API_URL", "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_API_URL", "GEMINI_EMBEDDING_MODEL"];
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

// ------------------------------------------------------------------ Gemini

const part = (text: string, thought = false): GeminiChunk => ({ candidates: [{ content: { parts: [{ text, thought }] } }] });
const GEMINI_REPLY: GeminiChunk[] = [part("Let me think about refraction.", true), part("Hello"), part(", student"), { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }];

async function* streamOf(chunks: GeminiChunk[], failAfter?: { count: number; error: unknown }) {
  for (let i = 0; i < chunks.length; i++) {
    if (failAfter && i >= failAfter.count) throw failAfter.error;
    yield chunks[i];
  }
  if (failAfter && failAfter.count >= chunks.length) throw failAfter.error;
}

const geminiError = (status: number, reason: string, detail = `Bad request for key ${GEMINI_KEY}`) =>
  new ApiError({ status, message: JSON.stringify({ error: { code: status, message: detail, status: reason, details: [{ reason }] } }) });

function gemini(open: (request: GeminiRequest) => Promise<AsyncIterable<GeminiChunk>>, overrides: { model?: string; effort?: "low" | "medium" | "high"; json?: boolean; responseTimeoutMs?: number } = {}) {
  const requests: GeminiRequest[] = [];
  const model = new GeminiChat({
    apiKey: GEMINI_KEY,
    model: "gemini-3.8-flash",
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

describe("Gemini provider", () => {
  it("implements the common interface: a model name and a stream of answer text", async () => {
    const { model } = gemini(async () => streamOf(GEMINI_REPLY));
    const common: TutorModel = model;

    assert.equal(common.model, "gemini-3.8-flash");
    // The model's thinking is not part of the answer.
    assert.equal(await collect(await common.streamChat(conversation)), "Hello, student");
  });

  it("sends the system prompt as an instruction and the conversation as user and model turns", () => {
    const { model } = gemini(async () => streamOf(GEMINI_REPLY));
    const request = model.buildRequest(conversation, new AbortController().signal);

    assert.equal(request.model, "gemini-3.8-flash");
    assert.equal(request.config!.systemInstruction, "You are Ari.");
    assert.deepEqual(request.contents, [
      { role: "user", parts: [{ text: "What is refraction?" }] },
      { role: "model", parts: [{ text: "The bending of light." }] },
      { role: "user", parts: [{ text: "Explain that more simply." }] },
    ]);
    assert.ok(!JSON.stringify(request).includes(GEMINI_KEY));
  });

  it("sets the answer length, thinking level and JSON mode in a way each model accepts", () => {
    const signal = new AbortController().signal;
    // A model that thinks first gets room for that on top of the answer.
    const flash = gemini(async () => streamOf([])).model.buildRequest(conversation, signal).config!;
    assert.equal(flash.maxOutputTokens, 5000);
    assert.deepEqual(flash.thinkingConfig, { thinkingLevel: "LOW" });
    assert.equal(flash.responseMimeType, undefined);

    const json = gemini(async () => streamOf([]), { json: true, effort: "medium" }).model.buildRequest(conversation, signal).config!;
    assert.equal(json.responseMimeType, "application/json");
    assert.deepEqual(json.thinkingConfig, { thinkingLevel: "MEDIUM" });

    // An older model takes no thinking level and is given no extra room.
    const old = gemini(async () => streamOf([]), { model: "gemini-2.0-flash" }).model.buildRequest(conversation, signal).config!;
    assert.equal(old.maxOutputTokens, 2000);
    assert.equal(old.thinkingConfig, undefined);
  });

  it("maps each kind of failure to a clean application error, before anything is streamed", async () => {
    const cases: [unknown, string, string][] = [
      [geminiError(400, "API_KEY_INVALID"), "PROVIDER_AUTH", "gemini 400 API_KEY_INVALID"],
      [geminiError(403, "PERMISSION_DENIED"), "PROVIDER_AUTH", "gemini 403 PERMISSION_DENIED"],
      [geminiError(429, "RESOURCE_EXHAUSTED"), "PROVIDER_RATE_LIMITED", "gemini 429 RESOURCE_EXHAUSTED"],
      [geminiError(404, "NOT_FOUND"), "PROVIDER_UNAVAILABLE", "gemini 404 NOT_FOUND (check GEMINI_MODEL)"],
      [new TypeError(`fetch failed for ${GEMINI_KEY}`), "PROVIDER_UNAVAILABLE", "gemini could not be reached"],
      [new SyntaxError(`Unexpected token near ${GEMINI_KEY}`), "PROVIDER_ERROR", "gemini reply could not be read: SyntaxError"],
    ];

    for (const [thrown, code, detail] of cases) {
      const { model } = gemini(async () => { throw thrown; }, { model: "gemini-2.0-flash" });
      const error = await failure(model.streamChat(conversation));
      assert.equal(error.code, code);
      assert.equal(error.detail, detail);
      // Neither the key nor the provider's message reaches the student or the log.
      assert.ok(!`${error.message} ${error.detail}`.includes(GEMINI_KEY));
      assert.ok(!/gemini|google/i.test(error.message));
    }
  });

  it("recognises an invalid key in the nested form the streaming API reports it in", async () => {
    // Recorded from the real API: the error body is JSON inside a JSON string.
    const inner = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, null, 2);
    const nested = new ApiError({ status: 400, message: JSON.stringify({ error: { message: inner, code: 400, status: "" } }) });
    const { model, requests } = gemini(async () => { throw nested; });

    const error = await failure(model.streamChat(conversation));
    assert.equal(error.code, "PROVIDER_AUTH");
    assert.equal(error.detail, "gemini 400 INVALID_ARGUMENT, API_KEY_INVALID");
    assert.equal(requests.length, 1, "a rejected key is not retried");
  });

  it("retries a brief outage once, and a rejected thinking level once without it", async () => {
    let calls = 0;
    const flaky = gemini(async () => {
      if (++calls === 1) throw geminiError(503, "UNAVAILABLE");
      return streamOf(GEMINI_REPLY);
    });
    assert.equal(await collect(await flaky.model.streamChat(conversation)), "Hello, student");
    assert.equal(flaky.requests.length, 2);

    const down = gemini(async () => { throw geminiError(503, "UNAVAILABLE"); });
    assert.equal((await failure(down.model.streamChat(conversation))).code, "PROVIDER_UNAVAILABLE");
    assert.equal(down.requests.length, 2);

    calls = 0;
    const picky = gemini(async () => {
      if (++calls === 1) throw geminiError(400, "INVALID_ARGUMENT");
      return streamOf(GEMINI_REPLY);
    });
    assert.equal(await collect(await picky.model.streamChat(conversation)), "Hello, student");
    assert.deepEqual(picky.requests.map((request) => Boolean(request.config!.thinkingConfig)), [true, false]);

    // An invalid key is not retried.
    const badKey = gemini(async () => { throw geminiError(400, "API_KEY_INVALID"); });
    assert.equal((await failure(badKey.model.streamChat(conversation))).code, "PROVIDER_AUTH");
    assert.equal(badKey.requests.length, 1);
  });

  it("treats a blocked or declined reply as a failure, not as an answer", async () => {
    const blocked = gemini(async () => streamOf([{ promptFeedback: { blockReason: "SAFETY" } }]));
    assert.equal((await failure(collect(await blocked.model.streamChat(conversation)))).code, "PROVIDER_REFUSED");

    const declined = gemini(async () => streamOf([part("I can"), { candidates: [{ finishReason: "SAFETY" }] }]));
    const error = await failure(collect(await declined.model.streamChat(conversation)));
    assert.equal(error.code, "PROVIDER_REFUSED");
    assert.equal(error.detail, "gemini stopped (SAFETY)");

    // A reply cut off at the length limit is still an answer.
    const long = gemini(async () => streamOf([part("A long answer"), { candidates: [{ finishReason: "MAX_TOKENS" }] }]));
    assert.equal(await collect(await long.model.streamChat(conversation)), "A long answer");
  });

  it("maps a failure partway through an answer, and gives up on a provider that does not answer in time", async () => {
    const dropped = gemini(async () => streamOf([part("Partial")], { count: 1, error: geminiError(500, "INTERNAL") }));
    assert.equal((await failure(collect(await dropped.model.streamChat(conversation)))).code, "PROVIDER_UNAVAILABLE");

    const slow = gemini((request) => new Promise((_resolve, reject) => {
      request.config!.abortSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), { responseTimeoutMs: 20 });
    assert.equal((await failure(slow.model.streamChat(conversation))).code, "TIMEOUT");
  });
});

// -------------------------------------------------------------------- Grok

const encoder = new TextEncoder();
const sse = (...texts: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const text of texts) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });

function grok(fetchImpl: typeof fetch, json = false) {
  return new OpenAICompatibleChat({ apiKey: XAI_KEY, model: "grok-4.7", baseUrl: "https://api.x.ai/v1", maxOutputTokens: 900, connectTimeoutMs: 1000, responseTimeoutMs: 1000, label: "xai", json, fetch: fetchImpl });
}

describe("Grok (xAI) provider", () => {
  it("implements the common interface against xAI's endpoint, with the key only in a header", async () => {
    const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const model: TutorModel = grok(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)), auth: new Headers(init!.headers).get("authorization") });
      return sse("Hello", ", student");
    }, true);

    assert.equal(await collect(await model.streamChat(conversation)), "Hello, student");
    assert.equal(model.model, "grok-4.7");
    assert.equal(requests[0].url, "https://api.x.ai/v1/chat/completions");
    assert.equal(requests[0].auth, `Bearer ${XAI_KEY}`);
    assert.deepEqual(requests[0].body, { model: "grok-4.7", messages: conversation, stream: true, max_tokens: 900, response_format: { type: "json_object" } });
    assert.ok(!JSON.stringify(requests[0].body).includes(XAI_KEY));
  });

  it("reports an account with no credit cleanly, without calling it a bad key or leaking billing details", async () => {
    // What xAI returns for a team with no credits.
    const body = { code: "permission-denied", error: `Your newly created team doesn't have any credits or licenses yet. You can purchase those on https://console.x.ai/team/1234 for key ${XAI_KEY}.` };
    const model = grok(async () => new Response(JSON.stringify(body), { status: 403 }));

    const error = await failure(model.streamChat(conversation));
    assert.equal(error.code, "PROVIDER_BILLING");
    assert.equal(error.detail, "xai API responded 403 (permission-denied)");
    for (const leaked of [XAI_KEY, "console.x.ai", "credits", "team"]) assert.ok(!`${error.message} ${error.detail}`.includes(leaked), leaked);

    // Through the tutor: one calm message, and the app keeps running.
    const response = await handleTutorChat(chatRequest({ message: "What is refraction?" }), { ...depsFor(world(), USER_A), getModel: () => model });
    const reply = (await response.json()) as TutorErrorBody;
    assert.equal(response.status, 503);
    assert.ok(reply.error.startsWith("Ari's AI service is temporarily unavailable."));
    assert.ok(!JSON.stringify(reply).includes("credit") && !JSON.stringify(reply).includes(XAI_KEY));
  });

  it("maps a rejected key, a rate limit and an outage", async () => {
    const cases = [[401, { code: "unauthenticated", error: `Incorrect API key provided: ${XAI_KEY}` }, "PROVIDER_AUTH"], [403, { code: "permission-denied", error: "This key is not allowed to use this model." }, "PROVIDER_AUTH"], [429, { code: "resource-exhausted", error: "Too many requests." }, "PROVIDER_RATE_LIMITED"], [503, {}, "PROVIDER_UNAVAILABLE"]] as const;
    for (const [status, body, code] of cases) {
      const error = await failure(grok(async () => new Response(JSON.stringify(body), { status })).streamChat(conversation));
      assert.equal(error.code, code);
      assert.ok(!`${error.message} ${error.detail}`.includes(XAI_KEY));
    }
    const offline = await failure(grok(async () => { throw new TypeError("fetch failed"); }).streamChat(conversation));
    assert.deepEqual([offline.code, offline.detail], ["PROVIDER_UNAVAILABLE", "xai request failed: TypeError"]);
  });
});

// ------------------------------------------------------- provider selection

describe("AI provider selection", () => {
  it("offers Gemini, Grok, Claude and the OpenAI-compatible provider", () => {
    assert.deepEqual([...AI_PROVIDERS], ["gemini", "xai", "anthropic", "openai"]);
    assert.deepEqual(DEFAULT_MODELS, { gemini: "gemini-3.8-flash", xai: "grok-4.7", anthropic: "claude-sonnet-5-5", openai: "gpt-4o-mini" });
  });

  it("selects each provider from AI_PROVIDER, each with its own key and model", () => {
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY }, () => {
      const model = getTutorModel();
      assert.ok(model instanceof GeminiChat);
      assert.equal(model.model, "gemini-3.8-flash");
    });
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY, GEMINI_MODEL: "gemini-3.5-flash-lite", AI_MODEL: "gpt-4o-mini" }, () => {
      // Another provider's model setting is not picked up.
      assert.equal(getTutorModel().model, "gemini-3.5-flash-lite");
    });
    withEnv({ AI_PROVIDER: "xai", XAI_API_KEY: XAI_KEY, XAI_MODEL: "grok-4.3" }, () => {
      const model = getTutorModel();
      assert.ok(model instanceof OpenAICompatibleChat);
      assert.equal(model.model, "grok-4.3");
    });
    withEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "sk-ant-test" }, () => assert.ok(getTutorModel() instanceof AnthropicChat));
    withEnv({ AI_PROVIDER: "openai", AI_API_KEY: "sk-proj-test", AI_API_URL: "https://api.openai.com/v1" }, () => assert.ok(getTutorModel() instanceof OpenAICompatibleChat));
    for (const [alias, provider] of [["Grok", "xai"], ["google", "gemini"], ["claude", "anthropic"]]) {
      withEnv({ AI_PROVIDER: alias }, () => assert.equal(aiProvider(), provider));
    }
    withEnv({}, () => assert.equal(aiProvider(), "anthropic"));
  });

  it("reports a missing key by the name of the variable that is missing", () => {
    for (const [provider, variable] of [["gemini", "GEMINI_API_KEY"], ["xai", "XAI_API_KEY"], ["anthropic", "AI_API_KEY"], ["openai", "AI_API_KEY"]]) {
      // Other providers' keys being present does not help.
      const others = { GEMINI_API_KEY: GEMINI_KEY, XAI_API_KEY: XAI_KEY, AI_API_KEY: "sk-ant-test", [variable]: undefined };
      withEnv({ ...others, AI_PROVIDER: provider }, () => {
        assert.equal(isTutorConfigured(), false);
        assert.throws(() => getTutorModel(), (error) => {
          assert.ok(error instanceof TutorError && error.code === "NOT_CONFIGURED");
          assert.ok(error.detail!.startsWith(`${variable} is not set`), error.detail);
          assert.ok(![GEMINI_KEY, XAI_KEY].some((key) => `${error.message} ${error.detail}`.includes(key)));
          return true;
        });
      });
    }
  });

  it("refuses a key filed under the wrong provider instead of sending it there", () => {
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: XAI_KEY }, () => {
      assert.match(aiConfigProblem()!, /GEMINI_API_KEY looks like an xAI key/);
      assert.ok(!aiConfigProblem()!.includes(XAI_KEY));
    });
    withEnv({ AI_PROVIDER: "xai", XAI_API_KEY: GEMINI_KEY }, () => assert.match(aiConfigProblem()!, /XAI_API_KEY looks like a Google key/));
    withEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: XAI_KEY }, () => assert.match(aiConfigProblem()!, /looks like an xAI key/));
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY }, () => assert.equal(aiConfigProblem(), null));
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY }, () => assert.equal(aiModel(), "gemini-3.8-flash"));
  });

  it("does not depend on Grok: Gemini works with no xAI key at all", () => {
    withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY }, () => {
      assert.equal(isTutorConfigured(), true);
      assert.ok(getTutorModel() instanceof GeminiChat);
    });
  });
});

// ------------------------------------------- the app, through each provider

// Any provider, replying with prepared text, so the same flows can be run
// through each of them.
function scripted(provider: "gemini" | "xai", replies: (string | object)[]) {
  const prompts: string[] = [];
  const next = () => {
    const reply = replies.shift() ?? "not json";
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  if (provider === "gemini") {
    const model = new GeminiChat({
      apiKey: GEMINI_KEY, model: "gemini-3.8-flash", maxOutputTokens: 2000, responseTimeoutMs: 2000,
      open: async (request) => {
        prompts.push(`${request.config!.systemInstruction}\n\n${JSON.stringify(request.contents)}`);
        const text = next();
        return streamOf([part(text.slice(0, 20)), part(text.slice(20))]);
      },
    });
    return { model, prompts };
  }
  const model = grok(async (_url, init) => {
    prompts.push(String(init!.body));
    const text = next();
    return sse(text.slice(0, 20), text.slice(20));
  });
  return { model, prompts };
}

const FIVE = [
  mcq("Which structure provides most of the eye's refractive power?"),
  trueFalse("The lens becomes flatter when the ciliary muscle contracts.", false),
  shortAnswer("Describe what happens to the lens during accommodation for near vision."),
  mcq("Where does light first enter the eye?", 1, { topic: "Anatomy" }),
  trueFalse("Myopia is corrected with a diverging lens.", true, 1, { topic: "Refractive error" }),
];

for (const provider of ["gemini", "xai"] as const) {
  describe(`Ari through ${provider}`, () => {
    it("gives the selected provider the student's own retrieved passages, and keeps citations correct", async () => {
      const w = world();
      const subject = w.db.addSubject(USER_A, "Optics");
      w.knowledge.add(USER_A, chunk({ content: "Refraction bends light as it enters glass.", materialTitle: "Optics Lecture 1", subjectId: subject.id, subjectName: "Optics", slideNumber: 4 }));
      w.knowledge.add(USER_B, chunk({ content: "B SECRET: the exam answers are 4, 8, 15.", materialTitle: "B private notes", score: 0.99 }));
      const { model, prompts } = scripted(provider, ["Light bends when it enters glass [1]."]);

      const response = await handleTutorChat(chatRequest({ message: "How does refraction work?", subjectId: subject.id }), { ...depsFor(w, USER_A), getModel: () => model });
      const events = await readEvents(response);

      assert.equal(events.at(-1)!.type, "done");
      assert.ok(prompts[0].includes("STUDY MATERIAL CONTEXT"));
      assert.ok(prompts[0].includes("Refraction bends light as it enters glass."));
      assert.ok(prompts[0].includes("Optics Lecture 1") && prompts[0].includes("slide 4"));
      // Another user's material never reaches the provider.
      assert.ok(!prompts[0].includes("B SECRET") && !prompts[0].includes("B private notes"));
      // The source reference is the knowledge base's own record.
      const start = events[0];
      assert.ok(start.type === "start");
      assert.deepEqual(start.sources.map((source) => [source.n, source.title, source.slide, source.page]), [[1, "Optics Lecture 1", 4, null]]);
      assert.equal(w.db.messages.at(-1)!.content, "Light bends when it enters glass [1].");
    });

    it("generates and validates a quiz, then marks answers", async () => {
      const w = practiceWorld();
      const subject = w.db.addSubject(USER_A, "Optics");
      w.knowledge.add(USER_A, chunk({ content: "The cornea provides about two thirds of the eye's refractive power.", materialTitle: "Optics Lecture 1", subjectId: subject.id, subjectName: "Optics", slideNumber: 4 }));
      const { model, prompts } = scripted(provider, [
        // One malformed question and one citing a passage that was not given: both dropped.
        { questions: [mcq("Only three options?", 1, { options: ["a", "b", "c"] }), mcq("From nowhere?", 7), ...FIVE] },
        { verdict: "partial", feedback: "Right about the muscle; you left out the change in the lens." },
      ]);
      const deps = { ...practiceDeps(w, USER_A), getModel: () => model };

      const { quiz } = await generateQuiz({ subjectId: subject.id, count: 5 }, deps);
      assert.equal(quiz.questionCount, 5);
      assert.deepEqual(w.db.questions.map((q) => q.type), ["multiple_choice", "true_false", "short_answer", "multiple_choice", "true_false"]);
      assert.ok(w.db.questions.every((q) => q.source!.title === "Optics Lecture 1" && q.source!.slide === 4));
      assert.ok(prompts[0].includes("The cornea provides about two thirds"));

      const { attempt, questions } = await startAttempt(quiz.id, deps);
      assert.equal((await answerQuestion({ attemptId: attempt.id, questionId: questions[0].id, answer: 0 }, deps)).result, "correct");
      assert.equal((await answerQuestion({ attemptId: attempt.id, questionId: questions[1].id, answer: true }, deps)).result, "incorrect");
      const marked = await answerQuestion({ attemptId: attempt.id, questionId: questions[2].id, answer: "the muscle tightens" }, deps);
      assert.deepEqual([marked.result, marked.feedback], ["partial", "Right about the muscle; you left out the change in the lens."]);
    });

    it("rejects a mark that is not in the expected shape", async () => {
      const w = practiceWorld();
      w.knowledge.add(USER_A, chunk({ content: "The cornea provides about two thirds of the eye's refractive power." }));
      const { model } = scripted(provider, [{ questions: FIVE }, { verdict: "excellent", feedback: "x" }, "Looks right to me!"]);
      const deps = { ...practiceDeps(w, USER_A), getModel: () => model };
      const { quiz } = await generateQuiz({ count: 5 }, deps);
      const { attempt, questions } = await startAttempt(quiz.id, deps);

      await assert.rejects(answerQuestion({ attemptId: attempt.id, questionId: questions[2].id, answer: "the lens changes" }, deps), (error) => error instanceof PracticeError && error.code === "EVALUATION_FAILED");
      assert.equal(w.db.answers.length, 0);
    });

    it("generates and validates a flashcard deck", async () => {
      const w = practiceWorld();
      w.knowledge.add(USER_A, chunk({ content: "The cornea provides about two thirds of the eye's refractive power.", materialTitle: "Optics Lecture 1", pageNumber: 12 }));
      const cards = Array.from({ length: 10 }, (_, i) => card(`Front about idea${i} gamma${i} delta${i}?`, `Back number ${i}.`));
      const { model } = scripted(provider, [{ cards: [{ front: "No back" }, card("Cites nothing given?", "Answer.", 9), ...cards] }]);

      const { deck, delivered } = await generateDeck({ count: 10 }, { ...practiceDeps(w, USER_A), getModel: () => model });

      assert.equal(delivered, 10);
      assert.ok(w.db.cards.every((item) => item.deckId === deck.id && item.source!.page === 12));
    });

    it("turns a provider failure into the same calm messages everywhere", async () => {
      const failing: TutorModel = provider === "gemini"
        ? gemini(async () => { throw geminiError(429, "RESOURCE_EXHAUSTED"); }, { model: "gemini-2.0-flash" }).model
        : grok(async () => new Response(JSON.stringify({ code: "resource-exhausted", error: "Too many requests." }), { status: 429 }));

      await assert.rejects(completeChat(failing, conversation, "GENERATION_FAILED"), (error) => error instanceof PracticeError && error.code === "PROVIDER_BUSY");
      const response = await handleTutorChat(chatRequest({ message: "Hi" }), { ...depsFor(world(), USER_A), getModel: () => failing });
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as TutorErrorBody).code, "PROVIDER_RATE_LIMITED");
    });

    it("still requires a signed-in user", async () => {
      const { model } = scripted(provider, ["unused"]);
      const response = await handleTutorChat(chatRequest({ message: "Hi" }), { ...depsFor(world(), null), getModel: () => model });
      assert.equal(response.status, 401);
      await assert.rejects(generateQuiz({ count: 5 }, { ...practiceDeps(practiceWorld(), null), getModel: () => model }), (error) => error instanceof PracticeError && error.code === "UNAUTHENTICATED");
    });
  });
}

// --------------------------------------------------------------- embeddings

describe("embedding providers", () => {
  const vector = (seed: number) => new Array(EMBEDDING_DIMENSIONS).fill(seed);

  function geminiEmbeddings(embed: (request: GeminiEmbedRequest) => Promise<number[][]>) {
    const requests: GeminiEmbedRequest[] = [];
    const provider = new GeminiEmbeddings({
      apiKey: GEMINI_KEY, model: "gemini-embedding-001", dimensions: EMBEDDING_DIMENSIONS, maxAttempts: 3, requestTimeoutMs: 1000, sleep: async () => {},
      embed: (request) => {
        requests.push(request);
        return embed(request);
      },
    });
    return { provider, requests };
  }

  it("keeps OpenAI as the default and adds Gemini as a free alternative", () => {
    withEnv({ EMBEDDING_API_KEY: "sk-test" }, () => {
      const provider = getEmbeddingProvider();
      assert.ok(provider instanceof OpenAICompatibleEmbeddings);
      assert.deepEqual([provider.model, provider.dimensions], ["text-embedding-3-small", 1536]);
    });
    withEnv({ EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY }, () => {
      const provider = getEmbeddingProvider();
      assert.ok(provider instanceof GeminiEmbeddings);
      // The same vector size, so the database column does not change.
      assert.deepEqual([provider.model, provider.dimensions], ["gemini-embedding-001", 1536]);
      assert.equal(isEmbeddingConfigured(), true);
    });
    // Gemini embeddings need no OpenAI key, and are chosen separately from the chat provider.
    withEnv({ EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY, AI_PROVIDER: "anthropic", AI_API_KEY: "sk-ant-test" }, () => assert.ok(getEmbeddingProvider() instanceof GeminiEmbeddings));
  });

  it("reports missing or unknown embedding settings cleanly", () => {
    withEnv({ EMBEDDING_PROVIDER: "gemini" }, () => {
      assert.match(embeddingConfigProblem()!, /^GEMINI_API_KEY is not set/);
      assert.throws(() => getEmbeddingProvider(), (error) => error instanceof ProcessingError && error.code === "EMBEDDING_NOT_CONFIGURED");
    });
    withEnv({}, () => assert.match(embeddingConfigProblem()!, /^EMBEDDING_API_KEY is not set/));
    withEnv({ EMBEDDING_PROVIDER: "cohere", EMBEDDING_API_KEY: "x" }, () => assert.match(embeddingConfigProblem()!, /not one of: openai, gemini/));
  });

  it("asks Gemini for 1536-dimension vectors, for documents and for questions, and normalises them", async () => {
    const { provider, requests } = geminiEmbeddings(async ({ texts }) => texts.map(() => vector(2)));

    const documents = await provider.embedDocuments(["first", "second"]);
    const question = await provider.embedQuery("what is refraction?");

    assert.deepEqual(requests.map((r) => [r.model, r.taskType, r.dimensions, r.texts.length]), [
      ["gemini-embedding-001", "RETRIEVAL_DOCUMENT", 1536, 2],
      ["gemini-embedding-001", "RETRIEVAL_QUERY", 1536, 1],
    ]);
    assert.equal(documents.length, 2);
    assert.equal(question.length, EMBEDDING_DIMENSIONS);
    const length = Math.sqrt(question.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(length - 1) < 1e-9, "vectors are scaled to length 1");
    assert.deepEqual(normalize([3, 4]), [0.6, 0.8]);
    assert.deepEqual(normalize([0, 0]), [0, 0]);
  });

  it("retries rate limits and outages, and does not retry a rejected key or leak it", async () => {
    let calls = 0;
    const flaky = geminiEmbeddings(async ({ texts }) => {
      calls++;
      if (calls === 1) throw geminiError(429, "RESOURCE_EXHAUSTED");
      if (calls === 2) throw geminiError(503, "UNAVAILABLE");
      return texts.map(() => vector(1));
    });
    assert.equal((await flaky.provider.embedQuery("question")).length, EMBEDDING_DIMENSIONS);
    assert.equal(calls, 3);

    const rejected = geminiEmbeddings(async () => { throw geminiError(400, "API_KEY_INVALID"); });
    await assert.rejects(rejected.provider.embedDocuments(["x"]), (error) => {
      assert.ok(error instanceof ProcessingError && error.code === "EMBEDDING_FAILED");
      assert.equal(error.detail, "gemini embedding API responded 400");
      assert.ok(!`${error.message} ${error.detail}`.includes(GEMINI_KEY));
      return true;
    });
    assert.equal(rejected.requests.length, 1);
  });

  it("rejects vectors of the wrong size instead of storing them", async () => {
    const short = geminiEmbeddings(async ({ texts }) => texts.map(() => new Array(768).fill(1)));
    await assert.rejects(short.provider.embedDocuments(["x"]), (error) => error instanceof ProcessingError && error.code === "EMBEDDING_FAILED");
  });

  it("sends Gemini smaller batches than the default", async () => {
    const { provider, requests } = geminiEmbeddings(async ({ texts }) => texts.map(() => vector(1)));
    await embedInBatches(provider, Array.from({ length: 40 }, (_, i) => `text ${i}`), async () => {});
    assert.deepEqual(requests.map((r) => r.texts.length), [16, 16, 8]);
  });

  it("tags stored chunks with their embedding model, and searches only that model's chunks", async () => {
    const store = new FakeStore();
    const embeddings = new FakeEmbeddings();
    store.add("notes", "txt", new TextEncoder().encode("Refraction bends light when it enters glass. Lenses use refraction to focus light."));
    assert.equal((await processMaterial("notes", { store, embeddings, ocr: null })).status, "ready");
    assert.equal(store.embeddingModels.get("notes"), "fake-embeddings");

    const repository = new FakeVectorRepository(store);
    await searchWith({ query: "how does refraction focus light", minScore: 0 }, embeddings, repository);
    assert.equal(repository.lastSearch!.embeddingModel, "fake-embeddings");
  });
});
