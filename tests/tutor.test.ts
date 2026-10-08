import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { KnowledgeBaseError } from "@/lib/ai/retrieval/query";
import { citedSources, linkCitations, sourceLabel } from "@/lib/ai/tutor/citations";
import { TUTOR } from "@/lib/ai/tutor/config";
import { buildModelMessages, buildSearch, selectHistory, selectPassages, titleFromMessage, toSources } from "@/lib/ai/tutor/context";
import { TUTOR_ERRORS, TutorError } from "@/lib/ai/tutor/errors";
import { handleTutorChat } from "@/lib/ai/tutor/handler";
import { OpenAICompatibleChat } from "@/lib/ai/tutor/openai-chat";
import { buildSystemPrompt, TUTOR_INSTRUCTIONS } from "@/lib/ai/tutor/prompt";
import { getTutorModel, isTutorConfigured } from "@/lib/ai/tutor/provider";
import type { TutorErrorBody, TutorMessage, TutorStreamEvent } from "@/lib/ai/tutor/types";
import { chatRequest, chunk, depsFor, readEvents, world, type World } from "./tutor-fakes";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function post(w: World, sessionUserId: string | null, body: unknown) {
  return handleTutorChat(chatRequest(body), depsFor(w, sessionUserId));
}

// Sends a message and returns the events of a successful answer.
async function ask(w: World, sessionUserId: string, body: unknown) {
  const response = await post(w, sessionUserId, body);
  assert.equal(response.status, 200, `expected an answer, got ${response.status}`);
  const events = await readEvents(response);
  const start = events[0] as Extract<TutorStreamEvent, { type: "start" }>;
  assert.equal(start.type, "start");
  return { events, start, last: events[events.length - 1] };
}

async function errorOf(response: Response) {
  return (await response.json()) as TutorErrorBody;
}

function message(role: TutorMessage["role"], content: string): TutorMessage {
  return { id: randomUUID(), role, content, sources: [], createdAt: "2026-10-07T09:00:00.000Z" };
}

describe("tutor chat: conversations", () => {
  it("creates a conversation for the signed-in user and saves both messages in it", async () => {
    const w = world();
    const { events, start, last } = await ask(w, USER_A, { message: "What is refraction?" });

    assert.equal(w.db.conversations.length, 1);
    assert.equal(w.db.conversations[0].userId, USER_A);
    assert.equal(start.conversation.id, w.db.conversations[0].id);
    assert.equal(start.conversation.title, "What is refraction?");
    assert.equal(start.conversation.subjectId, null);

    // The answer arrives in pieces, then is saved whole.
    assert.deepEqual(events.filter((e) => e.type === "delta").map((e) => e.type === "delta" && e.text), w.model.pieces);
    assert.equal(last.type, "done");

    assert.deepEqual(
      w.db.messages.map((m) => [m.role, m.content, m.userId, m.conversationId]),
      [
        ["user", "What is refraction?", USER_A, start.conversation.id],
        ["assistant", "Refraction is the bending of light.", USER_A, start.conversation.id],
      ],
    );
    assert.equal(last.type === "done" && last.message.id, w.db.messages[1].id);
  });

  it("lets a user read their own conversation back, and continues it with memory of earlier messages", async () => {
    const w = world();
    const first = await ask(w, USER_A, { message: "What is refraction?" });
    const id = first.start.conversation.id;

    const store = w.db.as(USER_A);
    assert.equal((await store.getConversation(id))!.title, "What is refraction?");
    assert.equal((await store.recentMessages(id, 50)).length, 2);

    await ask(w, USER_A, { conversationId: id, message: "Explain that more simply." });

    assert.equal(w.db.conversations.length, 1, "a follow-up must not start a new conversation");
    assert.equal(w.db.messages.filter((m) => m.conversationId === id).length, 4);
    // The model is shown the earlier exchange, then the new question.
    assert.deepEqual(
      w.model.calls[1].map((m) => [m.role, m.content]).slice(1),
      [
        ["user", "What is refraction?"],
        ["assistant", "Refraction is the bending of light."],
        ["user", "Explain that more simply."],
      ],
    );
  });

  it("puts each assistant message in the conversation it answers, when a user has several", async () => {
    const w = world();
    const one = (await ask(w, USER_A, { message: "First topic" })).start.conversation.id;
    const two = (await ask(w, USER_A, { message: "Second topic" })).start.conversation.id;
    w.model.pieces = ["More on the first."];
    await ask(w, USER_A, { conversationId: one, message: "Tell me more" });

    assert.notEqual(one, two);
    const inOne = w.db.messages.filter((m) => m.conversationId === one);
    const inTwo = w.db.messages.filter((m) => m.conversationId === two);
    assert.deepEqual(inOne.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(inTwo.map((m) => m.role), ["user", "assistant"]);
    assert.equal(inOne[3].content, "More on the first.");
    assert.ok(w.db.messages.every((m) => m.userId === USER_A));
  });
});

describe("tutor chat: isolation between users", () => {
  async function twoUsers() {
    const w = world();
    const subjectA = w.db.addSubject(USER_A, "Optics");
    const subjectB = w.db.addSubject(USER_B, "Private Law");
    w.knowledge.add(USER_A, chunk({ content: "Refraction bends light as it enters glass.", materialTitle: "Optics notes", subjectId: subjectA.id, subjectName: "Optics", pageNumber: 14 }));
    w.knowledge.add(USER_B, chunk({ content: "B SECRET: the exam answers are 4, 8, 15.", materialTitle: "B private notes", subjectId: subjectB.id, subjectName: "Private Law", score: 0.99 }));

    w.model.pieces = ["B's private answer."];
    const conversationB = (await ask(w, USER_B, { message: "B's private question", subjectId: subjectB.id })).start.conversation.id;
    w.model.pieces = ["An answer."];
    w.model.calls = [];
    w.knowledge.queries = [];
    return { w, subjectA, subjectB, conversationB };
  }

  it("does not let user B read user A's conversation or messages", async () => {
    const w = world();
    const conversationA = (await ask(w, USER_A, { message: "A's private question" })).start.conversation.id;

    const asB = w.db.as(USER_B);
    assert.equal(await asB.getConversation(conversationA), null);
    assert.deepEqual(await asB.recentMessages(conversationA, 50), []);

    // Through the API it is reported as not existing, and A's messages are
    // never shown to the model on B's behalf.
    w.model.calls = [];
    const response = await post(w, USER_B, { conversationId: conversationA, message: "What did we talk about?" });
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, "CONVERSATION_NOT_FOUND");
    assert.equal(w.model.calls.length, 0);
    assert.equal(w.db.messages.filter((m) => m.userId === USER_B).length, 0);
  });

  it("rejects another user's conversationId and adds nothing to that conversation", async () => {
    const { w, conversationB } = await twoUsers();
    const before = w.db.messages.length;

    const response = await post(w, USER_A, { conversationId: conversationB, message: "Let me in" });

    assert.equal(response.status, 404);
    const body = await errorOf(response);
    assert.equal(body.code, "CONVERSATION_NOT_FOUND");
    assert.equal(body.conversation, undefined);
    assert.equal(w.db.messages.length, before);
    assert.equal(w.model.calls.length, 0);
    assert.equal(w.knowledge.queries.length, 0);

    // "Try again" on someone else's conversation is refused the same way.
    const retry = await post(w, USER_A, { conversationId: conversationB, regenerate: true });
    assert.equal(retry.status, 404);
    assert.equal(w.model.calls.length, 0);
  });

  it("rejects another user's subjectId without searching or saving anything", async () => {
    const { w, subjectB } = await twoUsers();
    const before = { conversations: w.db.conversations.length, messages: w.db.messages.length };

    const response = await post(w, USER_A, { message: "Show me those notes", subjectId: subjectB.id });

    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, "SUBJECT_NOT_FOUND");
    assert.equal(w.knowledge.queries.length, 0, "no search may run for a subject the user does not own");
    assert.equal(w.model.calls.length, 0);
    assert.deepEqual({ conversations: w.db.conversations.length, messages: w.db.messages.length }, before);
  });

  it("cannot move an existing conversation onto another user's subject", async () => {
    const { w, subjectA, subjectB } = await twoUsers();
    const mine = (await ask(w, USER_A, { message: "About optics", subjectId: subjectA.id })).start.conversation.id;

    const response = await post(w, USER_A, { conversationId: mine, message: "Switch", subjectId: subjectB.id });

    assert.equal(response.status, 404);
    assert.equal(w.db.conversations.find((c) => c.id === mine)!.subjectId, subjectA.id);
  });

  it("searches only the signed-in user's materials, whatever the request claims", async () => {
    const { w } = await twoUsers();

    // Extra fields naming another user are not part of the API and are ignored.
    await ask(w, USER_A, { message: "What are the exam answers?", userId: USER_B, user_id: USER_B });

    assert.deepEqual(w.knowledge.queries.map((q) => q.userId), [USER_A]);
    assert.ok(!("userId" in w.knowledge.queries[0].query));
    assert.ok(!w.model.systemPrompt.includes("B SECRET"));
    assert.ok(!w.model.systemPrompt.includes("B private notes"));
    assert.ok(w.db.conversations.every((c) => c.userId !== USER_B || c.title === "B's private question"));
    assert.equal(w.db.conversations[w.db.conversations.length - 1].userId, USER_A);
  });

  it("never offers another user's passages as sources", async () => {
    const { w } = await twoUsers();
    const { start } = await ask(w, USER_A, { message: "How does refraction work?" });

    assert.deepEqual(start.sources.map((s) => s.title), ["Optics notes"]);
    assert.ok(w.model.systemPrompt.includes("Refraction bends light"));
    assert.deepEqual(w.db.messages[w.db.messages.length - 1].sources, start.sources);
  });
});

describe("tutor chat: authentication and validation", () => {
  it("returns 401 to a signed-out request and touches nothing", async () => {
    const w = world();
    const response = await post(w, null, { message: "Hello" });

    assert.equal(response.status, 401);
    assert.equal((await errorOf(response)).code, "UNAUTHENTICATED");
    assert.equal(w.db.conversations.length + w.db.messages.length, 0);
    assert.equal(w.knowledge.queries.length, 0);
    assert.equal(w.model.calls.length, 0);
  });

  it("checks authentication before reading the request", async () => {
    const response = await post(world(), null, "not json");
    assert.equal(response.status, 401);
  });

  it("returns a controlled error when no AI key is configured, and saves nothing", async () => {
    const w = world();
    w.configured = false;

    const response = await post(w, USER_A, { message: "What is refraction?" });
    const body = await errorOf(response);

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: TUTOR_ERRORS.NOT_CONFIGURED.message, code: "NOT_CONFIGURED" });
    assert.ok(!JSON.stringify(body).includes("AI_API_KEY"));
    assert.equal(w.db.conversations.length + w.db.messages.length, 0);
  });

  it("reads the key from the environment and fails cleanly without it", () => {
    const saved = { key: process.env.AI_API_KEY, model: process.env.AI_MODEL };
    try {
      delete process.env.AI_API_KEY;
      assert.equal(isTutorConfigured(), false);
      assert.throws(() => getTutorModel(), (error) => error instanceof TutorError && error.code === "NOT_CONFIGURED");

      process.env.AI_API_KEY = "sk-test-secret";
      process.env.AI_MODEL = "some-chat-model";
      assert.equal(isTutorConfigured(), true);
      assert.equal(getTutorModel().model, "some-chat-model");
    } finally {
      if (saved.key === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = saved.key;
      if (saved.model === undefined) delete process.env.AI_MODEL;
      else process.env.AI_MODEL = saved.model;
    }
  });

  it("rejects empty, oversized and malformed requests before doing any work", async () => {
    const w = world();
    const cases: [unknown, number, string][] = [
      [{ message: "   \n " }, 400, "EMPTY_MESSAGE"],
      [{}, 400, "EMPTY_MESSAGE"],
      [{ message: 42 }, 400, "INVALID_REQUEST"],
      [{ message: "x".repeat(TUTOR.maxMessageLength + 1) }, 400, "MESSAGE_TOO_LONG"],
      ["{ not json", 400, "INVALID_REQUEST"],
      [["a list"], 400, "INVALID_REQUEST"],
      [{ message: "Hi", conversationId: "not-a-uuid" }, 404, "CONVERSATION_NOT_FOUND"],
      [{ message: "Hi", conversationId: randomUUID() }, 404, "CONVERSATION_NOT_FOUND"],
      [{ message: "Hi", subjectId: "1 or 1=1" }, 404, "SUBJECT_NOT_FOUND"],
      [{ regenerate: true }, 409, "NOTHING_TO_RETRY"],
    ];

    for (const [body, status, code] of cases) {
      const response = await post(w, USER_A, body);
      assert.equal(response.status, status, JSON.stringify(body).slice(0, 60));
      assert.equal((await errorOf(response)).code, code);
    }
    assert.equal(w.db.conversations.length + w.db.messages.length, 0);
    assert.equal(w.model.calls.length, 0);
  });

  it("accepts a message of exactly the maximum length", async () => {
    const { last } = await ask(world(), USER_A, { message: "x".repeat(TUTOR.maxMessageLength) });
    assert.equal(last.type, "done");
  });

  it("limits how quickly one user can send messages, without affecting others", async () => {
    const w = world();
    for (let i = 0; i < TUTOR.messagesPerMinute; i++) await ask(w, USER_A, { message: `Question ${i}` });

    const blocked = await post(w, USER_A, { message: "One more" });
    assert.equal(blocked.status, 429);
    assert.equal((await errorOf(blocked)).code, "RATE_LIMITED");
    assert.equal(w.model.calls.length, TUTOR.messagesPerMinute);

    const other = await post(w, USER_B, { message: "My first question" });
    assert.equal(other.status, 200);
    await other.text();
  });
});

describe("tutor chat: study materials", () => {
  function library() {
    const w = world();
    const optics = w.db.addSubject(USER_A, "Optics");
    const biology = w.db.addSubject(USER_A, "Biology");
    w.knowledge.add(
      USER_A,
      chunk({ content: "Refraction bends light as it enters glass.", materialTitle: "Optics Lecture 1", subjectId: optics.id, subjectName: "Optics", pageNumber: 14, sectionTitle: "Refraction", score: 0.7 }),
      chunk({ content: "Mitochondria release energy for the cell.", materialTitle: "Cell Biology Slides", subjectId: biology.id, subjectName: "Biology", slideNumber: 7, score: 0.5 }),
      chunk({ content: "The syllabus lists six units.", materialTitle: "Optics Syllabus", subjectId: optics.id, subjectName: "Optics", score: 0.08 }),
    );
    return { w, optics, biology };
  }

  it("restricts the search to the selected subject and records it on the conversation", async () => {
    const { w, biology } = library();
    const { start } = await ask(w, USER_A, { message: "What do mitochondria do?", subjectId: biology.id });

    assert.equal(w.knowledge.queries[0].query.subjectId, biology.id);
    assert.equal(start.conversation.subjectId, biology.id);
    assert.deepEqual(start.sources.map((s) => s.title), ["Cell Biology Slides"]);
    assert.ok(w.model.systemPrompt.includes(`the student's subject "Biology"`));
    assert.ok(!w.model.systemPrompt.includes("Refraction bends light"));
  });

  it("searches every subject when 'All materials' is selected", async () => {
    const { w } = library();
    const { start } = await ask(w, USER_A, { message: "Compare light and cells", subjectId: null });

    assert.equal(w.knowledge.queries[0].query.subjectId, undefined);
    assert.deepEqual(start.sources.map((s) => s.title), ["Optics Lecture 1", "Cell Biology Slides"]);
    assert.ok(w.model.systemPrompt.includes("all of the student's uploaded materials"));
  });

  it("keeps a conversation's subject when the request does not name one, and changes it when it does", async () => {
    const { w, optics, biology } = library();
    const id = (await ask(w, USER_A, { message: "About light", subjectId: optics.id })).start.conversation.id;

    await ask(w, USER_A, { conversationId: id, message: "And glass?" });
    assert.equal(w.knowledge.queries[1].query.subjectId, optics.id);

    const switched = await ask(w, USER_A, { conversationId: id, message: "Now cells", subjectId: biology.id });
    assert.equal(switched.start.conversation.subjectId, biology.id);
    assert.equal(w.db.conversations[0].subjectId, biology.id);

    const all = await ask(w, USER_A, { conversationId: id, message: "Everything", subjectId: null });
    assert.equal(all.start.conversation.subjectId, null);
    assert.equal(w.knowledge.queries[3].query.subjectId, undefined);
  });

  it("gives the model numbered passages with the source details the knowledge base recorded, and no others", async () => {
    const { w } = library();
    const { start } = await ask(w, USER_A, { message: "Explain refraction and mitochondria" });

    assert.deepEqual(
      start.sources.map(({ n, title, subject, page, slide, section }) => ({ n, title, subject, page, slide, section })),
      [
        { n: 1, title: "Optics Lecture 1", subject: "Optics", page: 14, slide: null, section: "Refraction" },
        { n: 2, title: "Cell Biology Slides", subject: "Biology", page: null, slide: 7, section: null },
      ],
    );
    const prompt = w.model.systemPrompt;
    assert.ok(prompt.includes(`[1] "Optics Lecture 1" — subject: Optics — page 14 · Refraction`));
    assert.ok(prompt.includes(`[2] "Cell Biology Slides" — subject: Biology — slide 7`));
    assert.ok(!prompt.includes("page null") && !prompt.includes("slide null"));
  });

  it("limits how many passages are retrieved", async () => {
    const w = world();
    for (let i = 0; i < 40; i++) w.knowledge.add(USER_A, chunk({ content: `Passage ${i}`, score: 0.9 - i / 100 }));

    const { start } = await ask(w, USER_A, { message: "Tell me everything" });

    assert.equal(w.knowledge.queries[0].query.topK, TUTOR.defaultTopK);
    assert.equal(start.sources.length, TUTOR.defaultTopK);
    assert.ok(TUTOR.defaultTopK >= 5 && TUTOR.defaultTopK <= 8);
  });

  it("still answers, from general knowledge, when nothing relevant is found", async () => {
    const w = world();
    const { start, last } = await ask(w, USER_A, { message: "What is the capital of France?" });

    assert.deepEqual(start.sources, []);
    assert.equal(start.searched, true);
    assert.equal(last.type, "done");
    assert.ok(w.model.systemPrompt.includes("No passages were found"));
    assert.ok(w.model.systemPrompt.includes("Answer from general knowledge"));
  });

  it("still answers when the search fails, and tells the model and the browser", async () => {
    for (const failure of [new KnowledgeBaseError("NOT_CONFIGURED", "x"), new KnowledgeBaseError("SEARCH_FAILED", "x"), new Error("boom")]) {
      const w = world();
      w.knowledge.failWith = failure;
      const { start, last } = await ask(w, USER_A, { message: "What is refraction?" });

      assert.equal(start.searched, false);
      assert.deepEqual(start.sources, []);
      assert.equal(last.type, "done");
      assert.ok(w.model.systemPrompt.includes("could not be searched"));
    }
  });

  it("treats a signed-out search as a signed-out request", async () => {
    const w = world();
    w.knowledge.failWith = new KnowledgeBaseError("UNAUTHENTICATED", "x");
    const response = await post(w, USER_A, { message: "What is refraction?" });
    assert.equal(response.status, 401);
    assert.equal(w.model.calls.length, 0);
  });
});

describe("tutor chat: failures", () => {
  it("reports a provider failure with a friendly message and lets the question be retried without sending it twice", async () => {
    const w = world();
    w.model.failStart = new TutorError("PROVIDER_ERROR", "chat API responded 500");

    const failed = await post(w, USER_A, { message: "What is refraction?" });
    const body = await errorOf(failed);

    assert.equal(failed.status, 502);
    assert.equal(body.error, TUTOR_ERRORS.PROVIDER_ERROR.message);
    assert.ok(!JSON.stringify(body).includes("500"), "technical detail must not reach the browser");
    // The question is saved, and the response says which conversation it is in.
    assert.equal(body.conversation!.id, w.db.conversations[0].id);
    assert.deepEqual(w.db.messages.map((m) => m.role), ["user"]);

    w.model.failStart = null;
    const { start, last } = await ask(w, USER_A, { conversationId: body.conversation!.id, regenerate: true });

    assert.equal(start.userMessage, null);
    assert.equal(last.type, "done");
    assert.deepEqual(w.db.messages.map((m) => m.role), ["user", "assistant"]);
    const sent = w.model.calls[w.model.calls.length - 1];
    assert.deepEqual(sent.slice(1).map((m) => [m.role, m.content]), [["user", "What is refraction?"]]);
  });

  it("maps provider rate limits and timeouts to their own messages", async () => {
    for (const [code, status] of [["PROVIDER_RATE_LIMITED", 503], ["TIMEOUT", 504]] as const) {
      const w = world();
      w.model.failStart = new TutorError(code, "detail");
      const response = await post(w, USER_A, { message: "Hi" });
      assert.equal(response.status, status);
      assert.equal((await errorOf(response)).error, TUTOR_ERRORS[code].message);
    }
  });

  it("refuses to regenerate when the last question already has an answer", async () => {
    const w = world();
    const id = (await ask(w, USER_A, { message: "What is refraction?" })).start.conversation.id;

    const response = await post(w, USER_A, { conversationId: id, regenerate: true });

    assert.equal(response.status, 409);
    assert.equal(w.db.messages.length, 2);
  });

  it("ends the stream with an error and saves no answer when the model fails midway", async () => {
    const w = world();
    w.model.failAfter = 1;

    const { events, last } = await ask(w, USER_A, { message: "What is refraction?" });

    assert.deepEqual(events.map((e) => e.type), ["start", "delta", "error"]);
    assert.deepEqual(last, { type: "error", code: "PROVIDER_ERROR", message: TUTOR_ERRORS.PROVIDER_ERROR.message });
    assert.ok(!JSON.stringify(events).includes("sk-test-secret"));
    assert.deepEqual(w.db.messages.map((m) => m.role), ["user"]);
  });

  it("treats an empty answer as a failure", async () => {
    const w = world();
    w.model.pieces = ["  ", "\n"];
    const { last } = await ask(w, USER_A, { message: "Hello?" });
    assert.equal(last.type, "error");
    assert.deepEqual(w.db.messages.map((m) => m.role), ["user"]);
  });

  it("reports a database failure without internal details", async () => {
    const w = world();
    w.db.failWrites = true;

    const response = await post(w, USER_A, { message: "What is refraction?" });
    const body = await errorOf(response);

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: TUTOR_ERRORS.DATABASE_ERROR.message, code: "DATABASE_ERROR" });
    assert.ok(!JSON.stringify(body).includes("db-internal"));
    assert.equal(w.model.calls.length, 0);
  });

  it("finishes and saves the answer even if the browser stops listening", async () => {
    const w = world();
    const response = await post(w, USER_A, { message: "What is refraction?" });
    await response.body!.cancel();
    // Let the answer run to completion.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(w.db.messages.map((m) => [m.role, m.content]), [
      ["user", "What is refraction?"],
      ["assistant", "Refraction is the bending of light."],
    ]);
  });
});

describe("tutor context", () => {
  it("sends only the recent part of a long conversation, starting with the student", () => {
    const history: TutorMessage[] = [];
    for (let i = 0; i < 40; i++) history.push(message(i % 2 === 0 ? "user" : "assistant", `message ${i}`));

    const selected = selectHistory(history);

    assert.ok(selected.length <= TUTOR.historyMaxMessages);
    assert.equal(selected[0].role, "user");
    assert.equal(selected[selected.length - 1].content, "message 39");
    assert.ok(!selected.some((m) => m.content === "message 0"));
  });

  it("keeps the conversation within a size budget and shortens very long messages", () => {
    const long = "word ".repeat(TUTOR.historyMaxChars);
    const history = [message("user", "early question"), message("assistant", long), message("user", "recent question"), message("assistant", "recent answer")];

    const selected = selectHistory(history);
    const total = selected.reduce((sum, m) => sum + m.content.length, 0);

    assert.ok(total <= TUTOR.historyMaxChars);
    assert.deepEqual(selected.slice(-2).map((m) => m.content), ["recent question", "recent answer"]);
    assert.ok(selected.every((m) => m.content.length <= TUTOR.historyMessageMaxChars + 40));
  });

  it("orders the model's input as instructions, earlier conversation, then the question", () => {
    const messages = buildModelMessages({
      question: "And now?",
      history: [message("user", "Before"), message("assistant", "Earlier answer")],
      passages: [],
      subjectName: null,
      searched: true,
    });

    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.ok(messages[0].content.startsWith(TUTOR_INSTRUCTIONS));
    assert.equal(messages[3].content, "And now?");
  });

  it("searches a short follow-up together with the question before it", () => {
    const history = [message("user", "How does accommodation work in the eye?"), message("assistant", "The lens changes shape.")];

    assert.equal(buildSearch("Explain that more simply.", history, null, 6).query, "How does accommodation work in the eye? Explain that more simply.");
    assert.equal(buildSearch("I don't understand.", [], null, 6).query, "I don't understand.");

    const detailed = "What is the difference between myopia and hypermetropia, and how is each one corrected with lenses?";
    assert.equal(buildSearch(detailed, history, null, 6).query, detailed);
    assert.ok(buildSearch("x".repeat(5000), [], null, 6).query.length <= 2000);
  });

  it("only falls back to weak matches when a subject is selected", () => {
    const weak = [chunk({ content: "a", score: 0.12 }), chunk({ content: "b", score: 0.1 }), chunk({ content: "c", score: 0.09 }), chunk({ content: "d", score: 0.05 })];

    assert.equal(selectPassages(weak, false, 6).length, 0);
    assert.deepEqual(selectPassages(weak, true, 6).map((c) => c.content), ["a", "b", "c"]);

    const mixed = [chunk({ content: "strong", score: 0.6 }), ...weak];
    assert.deepEqual(selectPassages(mixed, true, 6).map((c) => c.content), ["strong"]);
    assert.equal(buildSearch("q", [], randomUUID(), 6).minScore, 0);
    assert.equal(buildSearch("q", [], null, 6).minScore, TUTOR.relevantScore);
  });

  it("caps the total size of the passages", () => {
    const big = Array.from({ length: 12 }, (_, i) => chunk({ content: `${i}`.padEnd(5000, "x"), score: 0.9 }));
    const chosen = selectPassages(big, false, 12);
    assert.ok(chosen.reduce((sum, c) => sum + c.content.length, 0) <= TUTOR.maxContextChars);
    assert.ok(chosen.length >= 1 && chosen.length < 12);
  });

  it("makes a short title from the first line of the first question", () => {
    assert.equal(titleFromMessage("  What is   accommodation?\nPlease be brief."), "What is accommodation?");
    assert.equal(titleFromMessage(""), "New chat");

    const title = titleFromMessage("Explain the difference between myopia and hypermetropia in terms a first year would understand");
    assert.ok(title.length <= TUTOR.titleMaxLength + 1);
    assert.ok(title.endsWith("…") && !title.includes("  "));
    assert.ok(titleFromMessage("x".repeat(500)).length <= TUTOR.titleMaxLength + 1);
  });
});

describe("tutor instructions", () => {
  it("separates the student's material from general knowledge and forbids inventing sources", () => {
    const prompt = buildSystemPrompt({ passages: [], subjectName: null, searched: true });

    for (const phrase of [
      "You are Ari, a patient AI study tutor",
      "STUDY MATERIAL CONTEXT",
      "GENERAL MODEL KNOWLEDGE",
      "never invent a title, page, slide or section",
      "Never present general knowledge as if it came from the student's materials",
      "never claim to have read",
      "do not repeat your previous explanation",
      "Do not force answers into headings",
      "do not turn the conversation into a quiz",
      "say so instead of guessing",
    ]) {
      assert.ok(prompt.includes(phrase), `instructions should include: ${phrase}`);
    }
    // Ari teaches from general knowledge rather than refusing.
    assert.ok(prompt.includes("Do not refuse just because something is not in the notes"));
  });

  it("copies passage text and source details into the context without adding any", () => {
    const passage = chunk({ content: "The cornea refracts most of the light.", materialTitle: "Ocular Anatomy", subjectName: "Anatomy" });
    const prompt = buildSystemPrompt({ passages: [passage], subjectName: "Anatomy", searched: true });

    assert.ok(prompt.includes(`[1] "Ocular Anatomy" — subject: Anatomy\n"""\nThe cornea refracts most of the light.\n"""`));
    assert.ok(!/\[1\][^\n]*(page|slide)/.test(prompt), "a passage with no page or slide must not be given one");
    assert.deepEqual(toSources([passage])[0], { n: 1, materialId: passage.materialId, title: "Ocular Anatomy", subject: "Anatomy", page: null, slide: null, section: null });
  });
});

describe("source references", () => {
  const sources = toSources([
    chunk({ content: "a", materialTitle: "Anatomy Lecture 3", pageNumber: 12 }),
    chunk({ content: "b", materialTitle: "Neuroanatomy Notes", pageNumber: 27, sectionTitle: "Cranial nerves" }),
    chunk({ content: "c", materialTitle: "Revision Slides", slideNumber: 4 }),
    chunk({ content: "d", materialTitle: "Loose notes" }),
  ]);

  it("labels a source with only the location details it has", () => {
    assert.deepEqual(sources.map(sourceLabel), [
      "Anatomy Lecture 3 — page 12",
      "Neuroanatomy Notes — page 27 · Cranial nerves",
      "Revision Slides — slide 4",
      "Loose notes",
    ]);
  });

  it("lists only the sources an answer actually cites", () => {
    assert.deepEqual(citedSources("The cornea bends light [1]. Nerves carry it onward [2, 3].", sources).map((s) => s.n), [1, 2, 3]);
    assert.deepEqual(citedSources("This is general knowledge, with no citation.", sources), []);
    // Numbers with no matching source, and brackets inside code, are not citations.
    assert.deepEqual(citedSources("See item [9]. Use `array[1]` or:\n```\nx = list[2]\n```", sources), []);
  });

  it("turns citation markers into reference links without touching code or real links", () => {
    assert.equal(linkCitations("Light bends [1][2].", sources), "Light bends [1](#source-1)[2](#source-2).");
    assert.equal(linkCitations("Both [1, 3] agree.", sources), "Both [1](#source-1)[3](#source-3) agree.");
    assert.equal(linkCitations("Read [1](https://example.com) and `a[1]`.", sources), "Read [1](https://example.com) and `a[1]`.");
    assert.equal(linkCitations("```js\nconst x = a[1];", sources), "```js\nconst x = a[1];");
    assert.equal(linkCitations("No sources [1].", []), "No sources [1].");
  });
});

describe("OpenAI-compatible chat provider", () => {
  const encoder = new TextEncoder();

  function sse(...lines: string[]) {
    return new Response(new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }), { status: 200 });
  }

  const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  function provider(fetchImpl: typeof fetch, overrides: { baseUrl?: string; connectTimeoutMs?: number } = {}) {
    return new OpenAICompatibleChat({
      apiKey: "sk-test-secret",
      model: "chat-model",
      baseUrl: "https://chat.test/v1",
      maxOutputTokens: 900,
      connectTimeoutMs: 1000,
      responseTimeoutMs: 1000,
      fetch: fetchImpl,
      ...overrides,
    });
  }

  async function collect(stream: AsyncIterable<string>) {
    let text = "";
    for await (const piece of stream) text += piece;
    return text;
  }

  it("sends the messages with the key in a header and streams the answer back", async () => {
    const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const chat = provider(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)), auth: new Headers(init!.headers).get("authorization") });
      // A chunk split in the middle of an event, a role-only chunk, and a comment line.
      const first = delta("Hello");
      return sse(`: keep-alive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n${first.slice(0, 20)}`, first.slice(20), delta(", student"), "data: [DONE]\n\n", delta("ignored"));
    });

    const text = await collect(await chat.streamChat([{ role: "system", content: "Be Ari" }, { role: "user", content: "Hi" }]));

    assert.equal(text, "Hello, student");
    assert.equal(requests[0].url, "https://chat.test/v1/chat/completions");
    assert.equal(requests[0].auth, "Bearer sk-test-secret");
    assert.deepEqual(requests[0].body, {
      model: "chat-model",
      messages: [{ role: "system", content: "Be Ari" }, { role: "user", content: "Hi" }],
      stream: true,
      max_tokens: 900,
    });
    assert.ok(!JSON.stringify(requests[0].body).includes("sk-test-secret"));
  });

  it("uses OpenAI's current name for the answer length limit on OpenAI's own API", async () => {
    let body: Record<string, unknown> = {};
    const chat = provider(async (_url, init) => {
      body = JSON.parse(String(init!.body));
      return sse(delta("ok"), "data: [DONE]\n\n");
    }, { baseUrl: "https://api.openai.com/v1" });

    await collect(await chat.streamChat([{ role: "user", content: "Hi" }]));
    assert.equal(body.max_completion_tokens, 900);
    assert.equal("max_tokens" in body, false);
  });

  it("reports a rejected key, a rate limit and a server error without leaking the key or the response", async () => {
    for (const [status, code] of [[401, "PROVIDER_AUTH"], [429, "PROVIDER_RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"], [400, "PROVIDER_ERROR"]] as const) {
      const chat = provider(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-test-secret" } }), { status }));

      await assert.rejects(chat.streamChat([{ role: "user", content: "Hi" }]), (error) => {
        assert.ok(error instanceof TutorError);
        assert.equal(error.code, code);
        assert.equal(error.detail, `chat API responded ${status}`);
        assert.ok(!`${error.message} ${error.detail}`.includes("sk-test-secret"));
        return true;
      });
    }
  });

  it("reports a network failure and a timeout as different errors", async () => {
    const offline = provider(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(offline.streamChat([{ role: "user", content: "Hi" }]), (error) => error instanceof TutorError && error.code === "PROVIDER_UNAVAILABLE");

    const slow = provider((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }), { connectTimeoutMs: 20 });
    await assert.rejects(slow.streamChat([{ role: "user", content: "Hi" }]), (error) => error instanceof TutorError && error.code === "TIMEOUT");
  });

  it("logs the provider's reason code, and does not call an account with no credit 'busy'", async () => {
    const error = { message: "You have no credits remaining for key sk-test-secret.", type: "insufficient_quota", code: "credit_balance_exhausted" };
    const broke = provider(async () => new Response(JSON.stringify({ error }), { status: 429 }));

    await assert.rejects(broke.streamChat([{ role: "user", content: "Hi" }]), (failure) => {
      assert.ok(failure instanceof TutorError);
      assert.equal(failure.code, "PROVIDER_BILLING");
      assert.equal(failure.detail, "chat API responded 429 (insufficient_quota, credit_balance_exhausted)");
      assert.ok(!`${failure.message} ${failure.detail}`.includes("sk-test-secret"));
      return true;
    });

    // A real rate limit is still reported as busy, and free text is never kept as a reason.
    const limited = provider(async () => new Response(JSON.stringify({ error: { type: "rate_limit_exceeded", code: "Slow down, key sk-test-secret" } }), { status: 429 }));
    await assert.rejects(limited.streamChat([{ role: "user", content: "Hi" }]), (failure) => {
      assert.ok(failure instanceof TutorError);
      assert.equal(failure.code, "PROVIDER_RATE_LIMITED");
      assert.equal(failure.detail, "chat API responded 429 (rate_limit_exceeded)");
      return true;
    });
  });

  it("fails the answer when the stream itself reports an error", async () => {
    const chat = provider(async () => sse(delta("Partial"), `data: ${JSON.stringify({ error: { message: "overloaded sk-test-secret" } })}\n\n`));
    const stream = await chat.streamChat([{ role: "user", content: "Hi" }]);

    await assert.rejects(collect(stream), (error) => {
      assert.ok(error instanceof TutorError && error.code === "PROVIDER_ERROR");
      assert.ok(!`${error.message} ${error.detail}`.includes("sk-test-secret"));
      return true;
    });
  });
});
