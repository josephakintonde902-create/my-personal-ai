// Central configuration for quizzes and flashcards. Nothing here is secret.
// Generation uses the tutor's AI provider (AI_PROVIDER, AI_API_KEY, AI_MODEL in
// lib/ai/tutor/provider.ts); there is no second provider.

export const QUESTION_TYPES = ["multiple_choice", "true_false", "short_answer"] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const RATINGS = ["again", "hard", "good", "easy"] as const;

export const PRACTICE = {
  // --- What a student can ask for -----------------------------------------
  quizSizes: [5, 10, 15, 20],
  deckSizes: [10, 15, 20, 30],
  // A quick practice session: no setup beyond choosing what to practise.
  practiceSize: 5,
  // Optional "focus on…" text for a quiz or deck.
  maxTopicLength: 200,
  maxShortAnswerLength: 1000,

  // --- Cost safety ---------------------------------------------------------
  // Quizzes and decks generated per student.
  generationsPerHour: 12,
  generationsPerDay: 40,
  // Attempts started per student per hour. Each can use the model to mark
  // short answers.
  attemptsPerHour: 40,

  // --- Study material given to the model ----------------------------------
  // Passages per generation. Override with PRACTICE_MAX_CHUNKS.
  defaultSourceChunks: 12,
  maxSourceChunks: 20,
  // Passages fetched from the knowledge base to choose those from.
  searchPoolSize: 50,
  // Each passage is shortened to this before it is sent.
  maxPassageChars: 2400,
  // Part of the source passage kept with a question, for marking short
  // answers and for "Ask Ari to explain".
  sourceExcerptChars: 1200,

  // --- Generation ----------------------------------------------------------
  // Items asked for per model call. Larger requests are split into batches.
  batchSize: 10,
  // Extra model calls allowed, per generation, when output is rejected.
  maxExtraCalls: 2,
  // A generation that ends with fewer items than this share of what was
  // asked for is treated as failed and nothing is saved.
  minDeliveredShare: 0.5,
  maxOutputTokens: 6000,
  // How hard the model should work, where the provider has such a setting.
  // Writing good questions deserves more care than marking one answer.
  generationEffort: "medium" as const,
  evaluationEffort: "low" as const,
  evaluationMaxOutputTokens: 500,
  // Questions that share this much of their wording are duplicates.
  duplicateSimilarity: 0.75,
};

export function practiceSourceChunks() {
  const value = Number.parseInt(process.env.PRACTICE_MAX_CHUNKS ?? "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 3), PRACTICE.maxSourceChunks) : PRACTICE.defaultSourceChunks;
}
