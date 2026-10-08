import { isUuid } from "@/lib/library/files";
import { PRACTICE, RATINGS } from "./config";
import { PracticeError } from "./errors";
import { buildFlashcardMessages } from "./flashcard-prompt";
import { db, generateItems, getModel, requireStore, resolveScope, retrievePassages, type PracticeDeps } from "./generate";
import { generatedCardSchema, isDuplicate, readItems } from "./schema";
import type { CardDraft, GenerateDeckInput, PracticeSource, Rating } from "./types";

// The flashcard flow: generate a deck from the student's materials, then
// record how well each card was remembered.

type CardRules = {
  sources: Map<number, { source: PracticeSource; excerpt: string }>;
  accepted: CardDraft[];
};

// Decides whether one generated card is good enough to keep. Returns the
// card in the form it is stored in, or null to reject it.
export function validateCard(item: unknown, { sources, accepted }: CardRules): CardDraft | null {
  const parsed = generatedCardSchema.safeParse(item);
  if (!parsed.success) return null;
  const card = parsed.data;

  // A card must point at a passage that was really provided. Its source
  // details are then copied from the knowledge base, not from the model.
  const origin = sources.get(card.source);
  if (!origin) return null;
  if (accepted.some((existing) => isDuplicate(existing.front, card.front))) return null;
  // A card whose two sides say the same thing teaches nothing.
  if (isDuplicate(card.front, card.back)) return null;

  return { front: card.front, back: card.back, difficulty: card.difficulty, source: origin.source };
}

// Generates a deck from the signed-in student's own study materials and
// saves it. Nothing is saved unless enough valid cards were produced.
export async function generateDeck(input: GenerateDeckInput, deps: PracticeDeps) {
  const store = await requireStore(deps);
  const count = Number(input?.count);
  if (!PRACTICE.deckSizes.includes(count)) throw new PracticeError("INVALID_REQUEST", "unsupported card count");
  // Checked before any work is done, so a missing key fails fast.
  const model = getModel(deps, PRACTICE.maxOutputTokens, PRACTICE.generationEffort);

  const scope = await resolveScope(store, input, deps.now?.() ?? new Date());
  const passages = await retrievePassages(deps, scope);

  const cards = await generateItems<CardDraft>({
    model,
    count,
    buildMessages: (want, accepted) =>
      buildFlashcardMessages({ count: want, passages: passages.text, alreadyWritten: accepted.map((card) => card.front) }),
    read: (reply) => readItems(reply, "cards"),
    accept: (item, accepted) => validateCard(item, { sources: passages.sources, accepted }),
  });

  const about = scope.material?.title ?? scope.subject?.name ?? "All subjects";
  const deck = await db(() =>
    store.createDeck({
      title: (scope.topic ? `${about}: ${scope.topic}` : about).slice(0, 150),
      subjectId: scope.subject?.id ?? null,
      materialId: scope.material?.id ?? null,
      cards,
    }),
  );
  return { deck, delivered: cards.length, requested: count };
}

// Records how well the student remembered one of their own cards.
export async function reviewCard(input: { flashcardId?: unknown; rating?: unknown }, deps: PracticeDeps) {
  const store = await requireStore(deps);
  const { flashcardId, rating } = input ?? {};
  if (!isUuid(flashcardId)) throw new PracticeError("NOT_FOUND", "malformed id");
  if (!RATINGS.includes(rating as Rating)) throw new PracticeError("INVALID_REQUEST", "unknown rating");

  return db(async () => {
    const card = await store.getCard(flashcardId);
    if (!card) throw new PracticeError("NOT_FOUND");
    return store.addReview(card.id, rating as Rating);
  });
}
