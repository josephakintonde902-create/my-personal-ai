import { isUuid } from "@/lib/library/files";
import type { IndexHealth, IndexScope } from "../retrieval/index-health";
import { KnowledgeBaseError, type KnowledgeBaseQuery } from "../retrieval/query";
import type { RetrievedChunk } from "../retrieval/repository";
import { TutorError } from "../tutor/errors";
import type { ChatMessage, ModelEffort, ModelOptions, TutorModel } from "../tutor/provider";
import { PRACTICE, practiceSourceChunks } from "./config";
import { PracticeError, toPracticeError } from "./errors";
import { buildPracticeSearch, describePassages, passageSources, selectPassages, type PracticeScope } from "./sources";
import type { PracticeStore } from "./store";

// Everything a quiz or flashcard operation needs from the outside world. The
// Server Actions supply the real session, database, search and model; tests
// supply stand-ins. Kept free of Next.js imports for that reason.
export type PracticeDeps = {
  // The signed-in user, from the verified session. Never from the request.
  getUser(): Promise<{ id: string } | null>;
  // A store acting for that user and no one else.
  openStore(userId: string): PracticeStore | Promise<PracticeStore>;
  // Searches the signed-in user's own materials (searchKnowledgeBase).
  search(query: KnowledgeBaseQuery): Promise<RetrievedChunk[]>;
  // The tutor's chat model. Throws TutorError("NOT_CONFIGURED") without a key.
  getModel(options?: ModelOptions): TutorModel;
  // What is really indexed for the signed-in user in a scope. Asked only
  // when a search comes back empty, to say why.
  inspect?(scope: IndexScope): Promise<IndexHealth>;
  // Reads the signed-in user's indexed passages in reading order, without
  // ranking them against anything (browseChunks).
  browse?(scope: IndexScope, limit: number): Promise<RetrievedChunk[]>;
  now?(): Date;
  // For shuffling answer options. Injectable so tests are repeatable.
  random?(): number;
};

export async function requireStore(deps: PracticeDeps) {
  const user = await deps.getUser();
  if (!user) throw new PracticeError("UNAUTHENTICATED");
  try {
    return await deps.openStore(user.id);
  } catch (error) {
    throw toPracticeError(error, "DATABASE_ERROR");
  }
}

// Runs a database step, reporting any failure as a database error.
export async function db<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw toPracticeError(error, "DATABASE_ERROR");
  }
}

export function getModel(deps: PracticeDeps, maxOutputTokens: number, effort: ModelEffort) {
  try {
    return deps.getModel({ maxOutputTokens, effort, json: true });
  } catch (error) {
    if (error instanceof TutorError && error.code === "NOT_CONFIGURED") throw new PracticeError("NOT_CONFIGURED", error.detail);
    throw toPracticeError(error);
  }
}

const UNAVAILABLE = new Set(["PROVIDER_AUTH", "PROVIDER_BILLING", "PROVIDER_UNAVAILABLE", "TIMEOUT"]);

// One complete reply from the chat model.
export async function completeChat(model: TutorModel, messages: ChatMessage[], failure: "GENERATION_FAILED" | "EVALUATION_FAILED") {
  try {
    let reply = "";
    for await (const piece of await model.streamChat(messages)) reply += piece;
    return reply;
  } catch (error) {
    if (error instanceof TutorError && error.code === "PROVIDER_RATE_LIMITED") throw new PracticeError("PROVIDER_BUSY", error.detail);
    // A rejected key, an empty balance or an outage: trying again with
    // different content will not help, so it is not called a failed attempt.
    if (error instanceof TutorError && UNAVAILABLE.has(error.code)) throw new PracticeError("AI_UNAVAILABLE", `${error.code}: ${error.detail}`);
    throw new PracticeError(failure, error instanceof TutorError ? error.detail : (error as Error).message);
  }
}

export function cleanTopic(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, PRACTICE.maxTopicLength) : "";
}

// Checks that the subject and material named in a request exist and belong
// to the signed-in user (the store finds no one else's), and that the
// student has not been generating too much.
export async function resolveScope(store: PracticeStore, input: { subjectId?: unknown; materialId?: unknown; topic?: unknown }, now: Date): Promise<PracticeScope> {
  const subjectId = input.subjectId || null;
  const materialId = input.materialId || null;
  // A malformed id is reported exactly like one that does not exist.
  if (subjectId !== null && !isUuid(subjectId)) throw new PracticeError("SUBJECT_NOT_FOUND", "malformed id");
  if (materialId !== null && !isUuid(materialId)) throw new PracticeError("MATERIAL_NOT_FOUND", "malformed id");

  return db(async () => {
    let subject = subjectId ? await store.getSubject(subjectId) : null;
    if (subjectId && !subject) throw new PracticeError("SUBJECT_NOT_FOUND");

    let material: PracticeScope["material"] = null;
    if (materialId) {
      const found = await store.getMaterial(materialId);
      if (!found || (subject && found.subjectId !== subject.id)) throw new PracticeError("MATERIAL_NOT_FOUND");
      if (found.status !== "ready") throw new PracticeError("MATERIAL_NOT_READY");
      material = { id: found.id, title: found.title };
      // A material always belongs to a subject; record it with what is made.
      subject ??= await store.getSubject(found.subjectId);
    }

    const [lastHour, lastDay] = await Promise.all([
      store.countGenerationsSince(new Date(now.getTime() - 60 * 60_000)),
      store.countGenerationsSince(new Date(now.getTime() - 24 * 60 * 60_000)),
    ]);
    if (lastHour >= PRACTICE.generationsPerHour || lastDay >= PRACTICE.generationsPerDay) throw new PracticeError("RATE_LIMITED");

    return { subject, material, topic: cleanTopic(input.topic) };
  });
}

// Retrieves the passages a quiz or deck will be written from, through the
// existing knowledge base search. Nothing is generated without them.
export async function retrievePassages(deps: PracticeDeps, scope: PracticeScope) {
  const limit = practiceSourceChunks();
  let results: RetrievedChunk[];
  try {
    results = await deps.search(buildPracticeSearch(scope, limit));
  } catch (error) {
    if (error instanceof KnowledgeBaseError && error.code === "UNAUTHENTICATED") throw new PracticeError("UNAUTHENTICATED");
    // A missing embedding key is a setup problem, not a missing material.
    if (error instanceof KnowledgeBaseError && error.code === "NOT_CONFIGURED") throw new PracticeError("NOT_CONFIGURED", "embedding provider is not configured");
    throw new PracticeError("KNOWLEDGE_BASE_UNAVAILABLE", error instanceof KnowledgeBaseError ? error.code : (error as Error).message);
  }

  let passages = selectPassages(results, limit, Boolean(scope.topic));
  if (passages.length === 0) passages = await explainEmptySearch(deps, scope, limit);
  return { text: describePassages(passages), sources: passageSources(passages) };
}

// A search that finds nothing has three quite different causes, and telling
// a student to "upload some material" is only right for one of them. This
// looks at what is really indexed and either recovers or says which it is:
//
//   nothing ready in scope            → NO_MATERIAL
//   ready, but nothing in the index   → MATERIAL_NOT_INDEXED
//   indexed, but out of the search's reach (its passages were embedded by a
//   different model than the one in use, so similarity cannot be measured)
//        open request  → read the passages in order instead; no ranking is
//                        needed to cover a whole lecture, so no vectors are
//                        compared and nothing is mixed
//        focused one   → MATERIAL_NEEDS_REPROCESS: a topic cannot be matched
//                        without comparable vectors
async function explainEmptySearch(deps: PracticeDeps, scope: PracticeScope, limit: number): Promise<RetrievedChunk[]> {
  const where: IndexScope = { subjectId: scope.subject?.id ?? null, materialId: scope.material?.id ?? null };
  let health: IndexHealth | null = null;
  try {
    health = (await deps.inspect?.(where)) ?? null;
  } catch (error) {
    console.error("[practice] index inspection failed", { detail: (error as Error).message });
  }
  // With no way to look, say what was always said.
  if (!health || health.readyMaterials === 0) throw new PracticeError("NO_MATERIAL");

  const detail = `ready materials ${health.readyMaterials}, chunks ${health.chunks}, searchable ${health.searchableChunks}, focused ${Boolean(scope.topic)}`;
  if (health.chunks === 0) throw new PracticeError("MATERIAL_NOT_INDEXED", detail);

  if (!scope.topic && deps.browse) {
    let passages: RetrievedChunk[] = [];
    try {
      passages = selectPassages(await deps.browse(where, limit), limit, false);
    } catch (error) {
      throw new PracticeError("KNOWLEDGE_BASE_UNAVAILABLE", `browse: ${(error as Error).message}`);
    }
    if (passages.length > 0) {
      // Worth a line in the server log: the library should offer Reprocess.
      console.warn("[practice] similarity search found nothing; read the indexed passages in order instead", { detail });
      return passages;
    }
  }
  throw new PracticeError(health.searchableChunks === 0 ? "MATERIAL_NEEDS_REPROCESS" : "NO_USABLE_CONTENT", detail);
}

type Generation<T> = {
  model: TutorModel;
  count: number;
  // The request for `want` more items, given those accepted so far.
  buildMessages(want: number, accepted: T[]): ChatMessage[];
  // The unvalidated items in a model reply.
  read(reply: string): unknown[];
  // Returns the validated item, or null to reject it.
  accept(item: unknown, accepted: T[]): T | null;
};

// Asks the model for items in batches until there are enough. Every item is
// validated on its own, so one bad item costs only itself. Rejected output
// is retried a limited number of times; the number of model calls is always
// bounded.
export async function generateItems<T>({ model, count, buildMessages, read, accept }: Generation<T>): Promise<T[]> {
  const accepted: T[] = [];
  const maxCalls = Math.ceil(count / PRACTICE.batchSize) + PRACTICE.maxExtraCalls;
  const enough = Math.max(1, Math.ceil(count * PRACTICE.minDeliveredShare));
  let rejected = 0;

  for (let call = 0; call < maxCalls && accepted.length < count; call++) {
    const want = Math.min(PRACTICE.batchSize, count - accepted.length);
    let reply: string;
    try {
      reply = await completeChat(model, buildMessages(want, accepted), "GENERATION_FAILED");
    } catch (error) {
      // A failed call late on still leaves a usable, shorter result.
      if (accepted.length >= enough) break;
      throw error;
    }

    for (const item of read(reply)) {
      if (accepted.length >= count) break;
      const valid = accept(item, accepted);
      if (valid) accepted.push(valid);
      else rejected++;
    }
  }

  if (accepted.length < enough) {
    throw new PracticeError("GENERATION_FAILED", `accepted ${accepted.length} of ${count}, rejected ${rejected}`);
  }
  return accepted;
}
