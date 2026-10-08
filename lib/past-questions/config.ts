import { SUPPORTED_MATERIAL_TYPES } from "@/lib/library/config";

// Central configuration for past questions and exam mode. Nothing here is
// secret. Topic analysis uses the tutor's AI provider (getTutorModel); there
// is no second provider.

// Images are left out on purpose: reading a photographed or scanned paper
// needs OCR, and Ari has no OCR provider yet (lib/ai/documents/ocr.ts). A
// scanned PDF is accepted for upload but fails processing with a clear
// message rather than producing invented questions.
export const PAST_QUESTION_TYPES = SUPPORTED_MATERIAL_TYPES.filter((type) => type.kind === "document");
export const PAST_QUESTION_TYPES_LABEL = PAST_QUESTION_TYPES.map((type) => type.label).join(", ");
export const PAST_QUESTION_ACCEPT = PAST_QUESTION_TYPES.flatMap((type) => [type.mimeType, ...type.extensions.map((extension) => `.${extension}`)]).join(",");

export const UNCATEGORIZED = "Uncategorized";

export const PAST = {
  // --- Collection details ---------------------------------------------------
  titleMaxLength: 150,
  examTypeMaxLength: 80,
  institutionMaxLength: 120,
  courseCodeMaxLength: 40,
  descriptionMaxLength: 1000,
  minYear: 1950,
  maxYear: 2100,

  // --- Reading questions out of a paper --------------------------------------
  // A paper with more questions than this is cut off rather than run up
  // storage and analysis costs.
  maxQuestionsPerSet: 600,
  // Longer than this and a "question" is almost certainly several things run
  // together, so it is kept as raw text instead.
  maxQuestionChars: 2000,
  maxOptionChars: 500,
  maxOptions: 6,
  // Raw (unrecognised) text is stored in pieces of about this size.
  rawBlockChars: 1500,
  maxRawBlocks: 120,
  // A numbering gap larger than this is not treated as the next question.
  maxNumberGap: 5,
  // After this long a 'processing' collection is assumed abandoned.
  staleProcessingMinutes: 15,
  processingTimeoutMs: 4 * 60_000,

  // --- Topic analysis (the only AI use in this feature) ----------------------
  // Questions sent to the model per call.
  analysisBatchSize: 20,
  // Model calls allowed per run. Questions beyond this stay unanalysed and
  // "Analyse with Ari" can be pressed again.
  analysisMaxCalls: 12,
  analysisMaxOutputTokens: 5000,
  analysisEffort: "low" as const,
  // Existing topic labels offered to the model so the same topic gets the
  // same name everywhere.
  maxKnownTopics: 60,
  maxTopicLength: 80,

  // --- Practice and exams ----------------------------------------------------
  practiceSizes: [5, 10, 20, 30],
  examSizes: [10, 20, 30, 50],
  // "All available" is capped here; the database allows no more.
  maxSessionQuestions: 200,
  examDurations: [15, 30, 45, 60],
  minCustomMinutes: 5,
  maxCustomMinutes: 240,
  // Must match public.exam_grace_seconds().
  graceSeconds: 30,
  // How often an open exam saves its answers to the server.
  autosaveSeconds: 20,
  // Difficulty can only be chosen when enough questions carry an estimate.
  minQuestionsPerDifficulty: 5,

  // --- Browsing ---------------------------------------------------------------
  maxListedQuestions: 6000,
  searchResults: 30,
  maxSearchLength: 120,
  frequentTopics: 8,
  recentSessions: 12,
};

export type PastSelection = "all" | "random" | "unanswered" | "missed" | "weak_topics";
export const PAST_SELECTIONS: PastSelection[] = ["random", "all", "unanswered", "missed", "weak_topics"];
