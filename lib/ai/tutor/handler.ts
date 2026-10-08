import { readJsonObject } from "@/lib/http/body";
import { isUuid } from "@/lib/library/files";
import { KnowledgeBaseError, type KnowledgeBaseQuery } from "../retrieval/query";
import type { RetrievedChunk } from "../retrieval/repository";
import { TUTOR, tutorTopK } from "./config";
import { buildModelMessages, buildSearch, selectPassages, titleFromMessage, toSources } from "./context";
import { toTutorError, TutorError } from "./errors";
import type { TutorModel } from "./provider";
import type { TutorStore } from "./store";
import type { TutorConversation, TutorErrorBody, TutorMessage, TutorSource, TutorStreamEvent } from "./types";

// Everything a tutor request needs from the outside world. The API route
// supplies the real session, database, search and model; tests supply
// stand-ins. Kept free of Next.js imports for that reason.
export type TutorDeps = {
  // The signed-in user, from the verified session. Never from the request.
  getUser(): Promise<{ id: string } | null>;
  // A store acting for that user and no one else.
  openStore(userId: string): TutorStore | Promise<TutorStore>;
  // Searches the signed-in user's own materials (searchKnowledgeBase).
  search(query: KnowledgeBaseQuery): Promise<RetrievedChunk[]>;
  // Throws TutorError("NOT_CONFIGURED") when there is no API key.
  getModel(): TutorModel;
  now?(): Date;
};

type ParsedRequest = {
  message: string;
  conversationId: string | null;
  // undefined = not sent (keep the conversation's subject), null = all materials.
  subjectId: string | null | undefined;
  regenerate: boolean;
};

async function parseRequest(request: Request): Promise<ParsedRequest> {
  const body = await readJsonObject(request);
  if (!body.ok) {
    // A body too large to be a real message is refused before it is parsed.
    throw body.reason === "too_large" ? new TutorError("MESSAGE_TOO_LONG", "request body over the size limit") : new TutorError("INVALID_REQUEST", "body is not a JSON object");
  }
  const input = body.value;
  const regenerate = input.regenerate === true;

  // A malformed id is reported exactly like one that does not exist.
  const conversationId = input.conversationId ?? null;
  if (conversationId !== null && !isUuid(conversationId)) throw new TutorError("CONVERSATION_NOT_FOUND", "malformed id");
  if (regenerate && conversationId === null) throw new TutorError("NOTHING_TO_RETRY", "no conversation given");

  let subjectId: string | null | undefined;
  if (input.subjectId === undefined) subjectId = undefined;
  else if (input.subjectId === null || input.subjectId === "") subjectId = null;
  else if (isUuid(input.subjectId)) subjectId = input.subjectId;
  else throw new TutorError("SUBJECT_NOT_FOUND", "malformed id");

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!regenerate) {
    if (input.message !== undefined && typeof input.message !== "string") throw new TutorError("INVALID_REQUEST", "message is not text");
    if (!message) throw new TutorError("EMPTY_MESSAGE");
    if (message.length > TUTOR.maxMessageLength) throw new TutorError("MESSAGE_TOO_LONG");
  }

  return { message, conversationId, subjectId, regenerate };
}

function errorResponse(error: TutorError, conversation?: TutorConversation) {
  const body: TutorErrorBody = { error: error.message, code: error.code };
  if (conversation) body.conversation = conversation;
  return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
}

function logFailure(stage: string, error: TutorError) {
  // Client mistakes (4xx) are not worth a log line; server-side failures are.
  if (error.status >= 500) console.error(`[tutor] ${stage} failed`, { code: error.code, detail: error.detail });
}

// Handles POST /api/tutor/chat.
//
//   authenticate → validate → check ownership → save the question → search
//   the student's materials → build the context → call the model → stream
//   the answer → save it
//
// Failures before the model starts answering come back as JSON with a proper
// status. After that the response is a stream of TutorStreamEvent lines, and
// a failure is its last event.
export async function handleTutorChat(request: Request, deps: TutorDeps): Promise<Response> {
  // Set once the question is saved, so a later failure can tell the browser
  // to retry without sending the question again.
  let conversation: TutorConversation | null = null;
  let questionSaved = false;

  try {
    const user = await deps.getUser();
    if (!user) throw new TutorError("UNAUTHENTICATED");

    const input = await parseRequest(request);
    // Checked before anything is written, so a missing key leaves no
    // unanswered question behind.
    const model = deps.getModel();
    const store = await deps.openStore(user.id);
    const now = deps.now?.() ?? new Date();

    // --- Ownership. The store only ever finds this user's rows. ------------
    let history: TutorMessage[] = [];
    let subject: { id: string; name: string } | null = null;
    let userMessage: TutorMessage | null = null;
    let question = input.message;

    try {
      if (input.conversationId) {
        conversation = await store.getConversation(input.conversationId);
        if (!conversation) throw new TutorError("CONVERSATION_NOT_FOUND");
      }

      const subjectId = input.subjectId === undefined ? (conversation?.subjectId ?? null) : input.subjectId;
      if (subjectId) {
        subject = await store.getSubject(subjectId);
        if (!subject) throw new TutorError("SUBJECT_NOT_FOUND");
      }

      // --- Cost safety -----------------------------------------------------
      const [lastMinute, lastDay] = await Promise.all([
        store.countUserMessagesSince(new Date(now.getTime() - 60_000)),
        store.countUserMessagesSince(new Date(now.getTime() - 24 * 60 * 60_000)),
      ]);
      if (lastMinute >= TUTOR.messagesPerMinute || lastDay >= TUTOR.messagesPerDay) throw new TutorError("RATE_LIMITED");

      // --- Conversation memory ---------------------------------------------
      if (conversation) history = await store.recentMessages(conversation.id, TUTOR.historyMaxMessages + 1);

      if (input.regenerate) {
        // Answer the question that is already saved and has no answer yet.
        const last = history[history.length - 1];
        if (!last || last.role !== "user") throw new TutorError("NOTHING_TO_RETRY");
        question = last.content;
        history = history.slice(0, -1);
        questionSaved = true;
      }

      // --- Save the question -----------------------------------------------
      if (!conversation) {
        conversation = await store.createConversation({ title: titleFromMessage(question), subjectId: subject?.id ?? null });
      } else if (conversation.subjectId !== (subject?.id ?? null)) {
        await store.setConversationSubject(conversation.id, subject?.id ?? null);
        conversation = { ...conversation, subjectId: subject?.id ?? null };
      }

      if (!input.regenerate) {
        userMessage = await store.addMessage({ conversationId: conversation.id, role: "user", content: question });
        questionSaved = true;
        conversation = { ...conversation, updatedAt: userMessage.createdAt };
      }
    } catch (error) {
      throw toTutorError(error, "DATABASE_ERROR");
    }

    // --- Search the student's own materials --------------------------------
    // A search that fails does not stop the lesson: Ari answers from general
    // knowledge and is told the notes could not be read.
    const topK = tutorTopK();
    let passages: RetrievedChunk[] = [];
    let searched = true;
    try {
      const results = await deps.search(buildSearch(question, history, subject?.id ?? null, topK));
      passages = selectPassages(results, Boolean(subject), topK);
    } catch (error) {
      if (error instanceof KnowledgeBaseError && error.code === "UNAUTHENTICATED") throw new TutorError("UNAUTHENTICATED");
      searched = false;
      console.error("[tutor] search failed", { code: error instanceof KnowledgeBaseError ? error.code : "UNKNOWN" });
    }
    const sources = toSources(passages);

    // --- Ask the model -------------------------------------------------------
    const messages = buildModelMessages({ question, history, passages, subjectName: subject?.name ?? null, searched });
    let answer: AsyncIterable<string>;
    try {
      answer = await model.streamChat(messages);
    } catch (error) {
      throw toTutorError(error, "PROVIDER_ERROR");
    }

    return streamAnswer({
      answer,
      store,
      conversation,
      sources,
      start: {
        type: "start",
        conversation,
        userMessage: userMessage && { id: userMessage.id, createdAt: userMessage.createdAt },
        sources,
        searched,
      },
    });
  } catch (error) {
    const tutorError = toTutorError(error);
    logFailure("request", tutorError);
    return errorResponse(tutorError, questionSaved && conversation ? conversation : undefined);
  }
}

type AnswerStream = {
  answer: AsyncIterable<string>;
  store: TutorStore;
  conversation: TutorConversation;
  sources: TutorSource[];
  start: TutorStreamEvent;
};

// Sends the answer to the browser piece by piece, then saves it. If the
// browser goes away mid-answer, the answer is still finished and saved, so it
// is there when the student comes back.
function streamAnswer({ answer, store, conversation, sources, start }: AnswerStream) {
  const encoder = new TextEncoder();
  let listening = true;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: TutorStreamEvent) => {
        if (!listening) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          listening = false;
        }
      };

      send(start);
      try {
        let text = "";
        for await (const piece of answer) {
          text += piece;
          send({ type: "delta", text: piece });
          if (text.length >= TUTOR.maxAnswerChars) break;
        }
        if (!text.trim()) throw new TutorError("PROVIDER_ERROR", "the model returned an empty answer");

        let saved: TutorMessage;
        try {
          saved = await store.addMessage({
            conversationId: conversation.id,
            role: "assistant",
            content: text.slice(0, TUTOR.maxAnswerChars),
            sources,
          });
        } catch (error) {
          throw new TutorError("ANSWER_NOT_SAVED", (error as Error).message);
        }
        send({ type: "done", message: { id: saved.id, createdAt: saved.createdAt } });
      } catch (error) {
        const tutorError = toTutorError(error, "PROVIDER_ERROR");
        logFailure("answer", tutorError);
        send({ type: "error", code: tutorError.code, message: tutorError.message });
      } finally {
        if (listening) {
          try {
            controller.close();
          } catch {
            // Already closed by the browser.
          }
        }
      }
    },
    cancel() {
      listening = false;
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Ask proxies not to hold the answer back until it is complete.
      "x-accel-buffering": "no",
    },
  });
}
