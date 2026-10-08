// In-memory stand-ins for the tutor's database, knowledge base and chat
// model, so the whole request flow can be tested without network access.
import { randomUUID } from "node:crypto";
import type { KnowledgeBaseQuery } from "@/lib/ai/retrieval/query";
import type { RetrievedChunk } from "@/lib/ai/retrieval/repository";
import { TutorError } from "@/lib/ai/tutor/errors";
import type { TutorDeps } from "@/lib/ai/tutor/handler";
import type { ChatMessage, TutorModel } from "@/lib/ai/tutor/provider";
import type { TutorStore } from "@/lib/ai/tutor/store";
import type { TutorConversation, TutorMessage, TutorStreamEvent } from "@/lib/ai/tutor/types";

type StoredConversation = TutorConversation & { userId: string };
type StoredMessage = TutorMessage & { userId: string; conversationId: string };

// Every user's tutor data in one place, the way one database holds it.
// `as(userId)` returns a store that behaves like the real one under Row Level
// Security: it finds only that user's rows and refuses to write into anyone
// else's. The real rules live in the database and are tested in
// supabase/tests/rls_tutor.sql; this models them so the request flow can be
// checked for how it uses them.
export class FakeTutorDb {
  subjects: { id: string; userId: string; name: string }[] = [];
  conversations: StoredConversation[] = [];
  messages: StoredMessage[] = [];
  // Set to make every write fail, like a database outage.
  failWrites = false;
  private clock = Date.parse("2026-10-07T09:00:00.000Z");

  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  now() {
    return new Date(this.clock);
  }

  addSubject(userId: string, name: string) {
    const subject = { id: randomUUID(), userId, name };
    this.subjects.push(subject);
    return subject;
  }

  as(userId: string): TutorStore {
    const owned = (id: string) => this.conversations.find((c) => c.id === id && c.userId === userId);
    const strip = ({ id, title, subjectId, updatedAt }: StoredConversation): TutorConversation => ({ id, title, subjectId, updatedAt });

    return {
      getSubject: async (id) => {
        const subject = this.subjects.find((s) => s.id === id && s.userId === userId);
        return subject ? { id: subject.id, name: subject.name } : null;
      },
      getConversation: async (id) => {
        const conversation = owned(id);
        return conversation ? strip(conversation) : null;
      },
      createConversation: async ({ title, subjectId }) => {
        if (this.failWrites) throw new Error("tutor_conversations insert: 08006 connection to db-internal.example failed");
        // The foreign key: a conversation's subject must have the same owner.
        if (subjectId && !this.subjects.some((s) => s.id === subjectId && s.userId === userId)) throw new Error("23503");
        const conversation = { id: randomUUID(), userId, title, subjectId, updatedAt: this.tick() };
        this.conversations.push(conversation);
        return strip(conversation);
      },
      setConversationSubject: async (id, subjectId) => {
        if (this.failWrites) throw new Error("tutor_conversations update: 08006");
        const conversation = owned(id);
        if (conversation) conversation.subjectId = subjectId;
      },
      recentMessages: async (conversationId, limit) =>
        this.messages
          .filter((m) => m.conversationId === conversationId && m.userId === userId)
          .slice(-limit)
          .map(({ id, role, content, sources, createdAt }) => ({ id, role, content, sources, createdAt })),
      addMessage: async ({ conversationId, role, content, sources = [] }) => {
        if (this.failWrites) throw new Error("tutor_messages insert: 08006");
        const conversation = owned(conversationId);
        // The foreign key: a message can only join the writer's own conversation.
        if (!conversation) throw new Error("23503");
        const message = { id: randomUUID(), role, content, sources, createdAt: this.tick() };
        this.messages.push({ ...message, userId, conversationId });
        conversation.updatedAt = message.createdAt;
        return message;
      },
      countUserMessagesSince: async (since) =>
        this.messages.filter((m) => m.userId === userId && m.role === "user" && Date.parse(m.createdAt) >= since.getTime()).length,
    };
  }
}

export function chunk(overrides: Partial<RetrievedChunk> & { content: string }): RetrievedChunk {
  return {
    chunkId: randomUUID(),
    score: 0.6,
    chunkIndex: 0,
    materialId: randomUUID(),
    materialTitle: "Notes",
    materialFilename: "notes.pdf",
    subjectId: randomUUID(),
    subjectName: "Subject",
    pageNumber: null,
    slideNumber: null,
    sectionTitle: null,
    ...overrides,
  };
}

// Each user's searchable passages. `searchAs(userId)` is what
// searchKnowledgeBase is to the real app: a search already tied to one
// signed-in user, with no way to name another.
export class FakeKnowledgeBase {
  private readonly chunks = new Map<string, RetrievedChunk[]>();
  queries: { userId: string; query: KnowledgeBaseQuery }[] = [];
  // Set to make searches fail.
  failWith: Error | null = null;
  // Materials whose passages are stored but tagged with a different
  // embedding model than the one in use. The real search filters on that
  // tag, so it returns nothing for them although they are indexed.
  mislabelled = new Set<string>();
  // How many times passages were read in order instead of searched for.
  browses = 0;

  // A user's stored passages in a scope, whether or not a search can reach them.
  stored(userId: string, scope: { subjectId?: string | null; materialId?: string | null } = {}) {
    return (this.chunks.get(userId) ?? [])
      .filter((c) => !scope.subjectId || c.subjectId === scope.subjectId)
      .filter((c) => !scope.materialId || c.materialId === scope.materialId);
  }

  // What browseChunks is to the real app: the passages in reading order,
  // spread evenly, with no ranking.
  browseAs(userId: string) {
    return async (scope: { subjectId?: string | null; materialId?: string | null }, limit: number) => {
      this.browses++;
      if (this.failWith) throw this.failWith;
      const ordered = this.stored(userId, scope).sort((a, b) => a.materialId.localeCompare(b.materialId) || a.chunkIndex - b.chunkIndex);
      return ordered.length <= limit ? ordered : Array.from({ length: limit }, (_, i) => ordered[Math.floor((i * ordered.length) / limit)]);
    };
  }

  add(userId: string, ...chunks: RetrievedChunk[]) {
    this.chunks.set(userId, [...(this.chunks.get(userId) ?? []), ...chunks]);
  }

  searchAs(userId: string) {
    return async (query: KnowledgeBaseQuery) => {
      this.queries.push({ userId, query });
      if (this.failWith) throw this.failWith;
      return (this.chunks.get(userId) ?? [])
        .filter((c) => !this.mislabelled.has(c.materialId))
        .filter((c) => !query.subjectId || c.subjectId === query.subjectId)
        .filter((c) => !query.materialId || c.materialId === query.materialId)
        .filter((c) => c.score >= (query.minScore ?? 0.2))
        .sort((a, b) => b.score - a.score)
        .slice(0, query.topK ?? 8);
    };
  }
}

export class FakeModel implements TutorModel {
  readonly model = "fake-tutor";
  calls: ChatMessage[][] = [];
  pieces = ["Refraction is ", "the bending of light."];
  // Fail before answering, like a refused request.
  failStart: TutorError | null = null;
  // Fail after this many pieces, like a dropped stream.
  failAfter: number | null = null;

  async streamChat(messages: ChatMessage[]) {
    this.calls.push(messages);
    if (this.failStart) throw this.failStart;
    const { pieces, failAfter } = this;
    return (async function* () {
      for (let i = 0; i < pieces.length; i++) {
        if (failAfter !== null && i >= failAfter) throw new TutorError("PROVIDER_ERROR", "stream dropped: sk-test-secret");
        yield pieces[i];
      }
    })();
  }

  get systemPrompt() {
    return this.calls[this.calls.length - 1][0].content;
  }
}

export type World = { db: FakeTutorDb; knowledge: FakeKnowledgeBase; model: FakeModel; configured: boolean };

export function world(): World {
  return { db: new FakeTutorDb(), knowledge: new FakeKnowledgeBase(), model: new FakeModel(), configured: true };
}

// The dependencies of one request, all derived from the session, exactly as
// the API route builds them. `sessionUserId` null means signed out.
export function depsFor(w: World, sessionUserId: string | null): TutorDeps {
  return {
    getUser: async () => (sessionUserId ? { id: sessionUserId } : null),
    openStore: (userId) => w.db.as(userId),
    search: w.knowledge.searchAs(sessionUserId ?? "signed-out"),
    getModel: () => {
      if (!w.configured) throw new TutorError("NOT_CONFIGURED", "AI_API_KEY is not set");
      return w.model;
    },
    now: () => w.db.now(),
  };
}

export function chatRequest(body: unknown) {
  return new Request("https://ari.test/api/tutor/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function readEvents(response: Response) {
  const text = await response.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TutorStreamEvent);
}
