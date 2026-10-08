// Every way a quiz or flashcard request can fail, with the message the
// student sees. Messages never contain stack traces, model output, database
// details, or secrets.
export const PRACTICE_ERRORS = {
  UNAUTHENTICATED: "Your session has expired. Please sign in again.",
  INVALID_REQUEST: "That request couldn't be understood. Please try again.",
  SUBJECT_NOT_FOUND: "That subject no longer exists. Choose another one.",
  MATERIAL_NOT_FOUND: "That study material no longer exists. Choose another one.",
  MATERIAL_NOT_READY: "That material is still being prepared for Ari. Try again once it shows “Ready for Ari”.",
  // Three different situations that an empty search cannot tell apart on its
  // own (see explainEmptySearch in generate.ts). Each says what to do next.
  NO_MATERIAL: "No ready study material is available here. Upload a material and wait until it shows “Ready for Ari”.",
  MATERIAL_NOT_INDEXED: "This material is marked ready, but no indexed content was found for it. Open My library and press Reprocess, then try again.",
  MATERIAL_NEEDS_REPROCESS: "This material was indexed with a different embedding model, so Ari can't search it by topic yet. Open My library and press Reprocess, then try again, or leave “Focus on” empty.",
  NO_USABLE_CONTENT: "Ari found this material, but there wasn't enough readable text in it to work from.",
  KNOWLEDGE_BASE_UNAVAILABLE: "Ari couldn't read your study materials just now. Please try again.",
  NOT_FOUND: "We couldn't find that. It may have been deleted.",
  ATTEMPT_COMPLETED: "This quiz attempt is already finished.",
  INVALID_ANSWER: "That answer couldn't be read. Please try again.",
  EMPTY_ANSWER: "Write an answer first.",
  RATE_LIMITED: "You've created a lot in a short time. Give it a little while, then try again.",
  NOT_CONFIGURED: "Ari isn't set up to create quizzes and flashcards yet.",
  AI_UNAVAILABLE: "Ari's AI service is temporarily unavailable. Please try again.",
  PROVIDER_BUSY: "Ari is very busy right now. Please try again in a moment.",
  GENERATION_FAILED: "The study material was found, but Ari couldn't generate this right now. Please try again.",
  EVALUATION_FAILED: "Ari couldn't check that answer just now. Please try again.",
  // Past questions and exam mode.
  NO_PAST_QUESTIONS: "There are no past questions to practise yet. Upload a past paper first, and wait until it shows “Ready”.",
  NO_ANSWERS_AVAILABLE: "None of these questions has an answer to mark against. The uploaded paper has no answer key, and Ari hasn't been able to work the answers out yet.",
  NO_MATCHING_QUESTIONS: "No questions match those choices. Try a different year, topic or selection.",
  NOT_ENOUGH_QUESTIONS: "There aren't enough questions for an exam of that size. Choose fewer questions, or “All available”.",
  DIFFICULTY_UNAVAILABLE: "These questions have no difficulty rating, so they can't be filtered by difficulty. Choose “Mixed”.",
  INVALID_TIME_LIMIT: "Choose a time limit between 5 minutes and 4 hours, or no timer.",
  EXAM_NOT_FOUND: "We couldn't find that exam. It may have been deleted.",
  EXAM_SUBMIT_FAILED: "We couldn't submit your exam. Your answers are still here: please try again.",
  DATABASE_ERROR: "We couldn't save that. Please try again.",
  UNKNOWN: "Something went wrong. Please try again.",
} as const;

export type PracticeErrorCode = keyof typeof PRACTICE_ERRORS;

export class PracticeError extends Error {
  readonly code: PracticeErrorCode;
  // Technical detail for server logs only. Never sent to the browser.
  readonly detail?: string;

  constructor(code: PracticeErrorCode, detail?: string) {
    super(PRACTICE_ERRORS[code]);
    this.name = "PracticeError";
    this.code = code;
    this.detail = detail;
  }
}

export function toPracticeError(error: unknown, fallback: PracticeErrorCode = "UNKNOWN") {
  if (error instanceof PracticeError) return error;
  return new PracticeError(fallback, error instanceof Error ? error.message : String(error));
}

// The result of a quiz or flashcard operation, in a shape Server Actions can
// return to the browser.
export type PracticeResult<T> = { ok: true; data: T } | { ok: false; error: string; code: PracticeErrorCode };

const QUIET = new Set<PracticeErrorCode>([
  "UNAUTHENTICATED", "INVALID_REQUEST", "SUBJECT_NOT_FOUND", "MATERIAL_NOT_FOUND", "MATERIAL_NOT_READY", "NO_MATERIAL", "MATERIAL_NEEDS_REPROCESS", "NO_USABLE_CONTENT",
  "NOT_FOUND", "ATTEMPT_COMPLETED", "INVALID_ANSWER", "EMPTY_ANSWER", "RATE_LIMITED",
  "NO_PAST_QUESTIONS", "NO_ANSWERS_AVAILABLE", "NO_MATCHING_QUESTIONS", "NOT_ENOUGH_QUESTIONS", "DIFFICULTY_UNAVAILABLE", "INVALID_TIME_LIMIT", "EXAM_NOT_FOUND",
]);

// Runs an operation and turns any failure into a friendly result. Mistakes
// in a request are not logged; failures on our side are.
export async function toResult<T>(stage: string, operation: () => Promise<T>): Promise<PracticeResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    const practiceError = toPracticeError(error);
    if (!QUIET.has(practiceError.code)) {
      console.error(`[practice] ${stage} failed`, { code: practiceError.code, detail: practiceError.detail });
    }
    return { ok: false, error: practiceError.message, code: practiceError.code };
  }
}
