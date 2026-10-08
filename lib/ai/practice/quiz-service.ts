import { isUuid } from "@/lib/library/files";
import { DIFFICULTIES, PRACTICE, QUESTION_TYPES } from "./config";
import { PracticeError } from "./errors";
import { buildEvaluationMessages } from "./evaluation-prompt";
import { completeChat, db, generateItems, getModel, requireStore, resolveScope, retrievePassages, type PracticeDeps } from "./generate";
import { buildQuizMessages } from "./quiz-prompt";
import { evaluationSchema, generatedQuestionSchema, isDuplicate, normalizeText, parseModelJson, readItems } from "./schema";
import type {
  AnswerFeedback,
  AnswerResult,
  DifficultyChoice,
  GenerateQuizInput,
  PracticeSource,
  PublicQuestion,
  QuestionDraft,
  QuestionType,
  QuizAnswer,
  QuizAttempt,
  QuizQuestion,
  QuizSummary,
} from "./types";

// The quiz flow: generate a quiz from the student's materials, take it one
// answer at a time, and finish with a score. Each step starts from the
// session's user and looks everything else up as that user.

type QuestionRules = {
  allowedTypes: QuestionType[];
  difficulty: DifficultyChoice;
  sources: Map<number, { source: PracticeSource; excerpt: string }>;
  accepted: QuestionDraft[];
  random: () => number;
};

const CATCH_ALL_OPTION = /^(all|none|both|neither) of (the|these) (above|options|answers)|^(all|none) of them|^both [a-d] and [a-d]/i;

function shuffle<T>(items: T[], random: () => number) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Decides whether one generated question is good enough to keep. Returns
// the question in the form it is stored in, or null to reject it.
export function validateQuestion(item: unknown, { allowedTypes, difficulty, sources, accepted, random }: QuestionRules): QuestionDraft | null {
  const parsed = generatedQuestionSchema.safeParse(item);
  if (!parsed.success) return null;
  const generated = parsed.data;

  if (!allowedTypes.includes(generated.type)) return null;
  // A question must point at a passage that was really provided. Its source
  // details are then copied from the knowledge base, not from the model.
  const origin = sources.get(generated.source);
  if (!origin) return null;
  if (accepted.some((existing) => isDuplicate(existing.question, generated.question))) return null;

  const draft = {
    question: generated.question,
    explanation: generated.explanation,
    topic: generated.topic,
    difficulty: difficulty === "mixed" ? generated.difficulty : difficulty,
    source: origin.source,
    sourceExcerpt: origin.excerpt,
  };

  if (generated.type === "multiple_choice") {
    const { options } = generated;
    if (new Set(options.map(normalizeText)).size !== options.length) return null;
    if (options.some((option) => CATCH_ALL_OPTION.test(option))) return null;

    const correct = options[generated.correctIndex];
    const others = options.filter((_, index) => index !== generated.correctIndex);
    const typical = others.reduce((sum, option) => sum + option.length, 0) / others.length;
    // The right answer must not give itself away by being much the longest.
    if (correct.length > typical * 2 && correct.length - typical > 60) return null;

    // The model tends to put the answer in the same place; shuffle it.
    return { ...draft, type: "multiple_choice", options: shuffle(options, random), correctAnswer: correct, acceptablePoints: [] };
  }
  if (generated.type === "true_false") {
    return { ...draft, type: "true_false", options: [], correctAnswer: generated.correctAnswer, acceptablePoints: [] };
  }
  return { ...draft, type: "short_answer", options: [], correctAnswer: generated.expectedAnswer, acceptablePoints: generated.acceptablePoints };
}

function parseSettings(input: GenerateQuizInput) {
  const mode = input.mode === "practice" ? "practice" : "quiz";
  const count = mode === "practice" ? PRACTICE.practiceSize : Number(input.count);
  if (!PRACTICE.quizSizes.includes(count)) throw new PracticeError("INVALID_REQUEST", "unsupported question count");

  const difficulty = input.difficulty ?? "mixed";
  if (difficulty !== "mixed" && !DIFFICULTIES.includes(difficulty)) throw new PracticeError("INVALID_REQUEST", "unsupported difficulty");

  const choice = input.questionType ?? "mixed";
  if (choice !== "mixed" && !QUESTION_TYPES.includes(choice)) throw new PracticeError("INVALID_REQUEST", "unsupported question type");
  const types: QuestionType[] = choice === "mixed" ? [...QUESTION_TYPES] : [choice];

  return { mode, count, difficulty, types } as const;
}

// Generates a quiz from the signed-in student's own study materials and
// saves it. Nothing is saved unless enough valid questions were produced.
export async function generateQuiz(input: GenerateQuizInput, deps: PracticeDeps) {
  const store = await requireStore(deps);
  const { mode, count, difficulty, types } = parseSettings(input ?? {});
  // Checked before any work is done, so a missing key fails fast.
  const model = getModel(deps, PRACTICE.maxOutputTokens, PRACTICE.generationEffort);

  const scope = await resolveScope(store, input, deps.now?.() ?? new Date());
  const passages = await retrievePassages(deps, scope);

  const questions = await generateItems<QuestionDraft>({
    model,
    count,
    buildMessages: (want, accepted) =>
      buildQuizMessages({ count: want, types, difficulty, passages: passages.text, alreadyWritten: accepted.map((question) => question.question) }),
    read: (reply) => readItems(reply, "questions"),
    accept: (item, accepted) =>
      validateQuestion(item, { allowedTypes: types, difficulty, sources: passages.sources, accepted, random: deps.random ?? Math.random }),
  });

  const about = scope.material?.title ?? scope.subject?.name ?? "All subjects";
  const title = (mode === "practice" ? `Practice: ${about}` : scope.topic ? `${about}: ${scope.topic}` : about).slice(0, 150);

  const quiz = await db(() =>
    store.createQuiz({
      title,
      mode,
      subjectId: scope.subject?.id ?? null,
      materialId: scope.material?.id ?? null,
      difficulty,
      // The types the quiz actually contains.
      questionTypes: types.filter((type) => questions.some((question) => question.type === type)),
      questions,
    }),
  );
  return { quiz, requested: count };
}

export function toPublicQuestion({ id, position, type, question, options }: QuizQuestion): PublicQuestion {
  return { id, position, type, question, options };
}

// What the student is shown once a question has been answered (or, in a
// finished attempt, left unanswered).
export function toFeedback(question: QuizQuestion, answer: QuizAnswer | undefined): AnswerFeedback {
  return {
    answerId: answer?.id ?? "",
    questionId: question.id,
    answer: answer?.answer ?? "",
    result: answer?.result ?? "incorrect",
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    feedback: answer?.feedback ?? "",
    source: question.source,
    topic: question.topic,
    ...(question.answerSource ? { answerSource: question.answerSource } : {}),
  };
}

// Starts a new attempt at one of the student's own quizzes.
export async function startAttempt(quizId: unknown, deps: PracticeDeps) {
  const store = await requireStore(deps);
  if (!isUuid(quizId)) throw new PracticeError("NOT_FOUND", "malformed id");
  const now = deps.now?.() ?? new Date();

  return db(async () => {
    const quiz = await store.getQuiz(quizId);
    // An exam is sat through exam mode only: here each answer would be
    // marked as it is given.
    if (!quiz || quiz.mode === "exam") throw new PracticeError("NOT_FOUND");
    if ((await store.countAttemptsSince(new Date(now.getTime() - 60 * 60_000))) >= PRACTICE.attemptsPerHour) {
      throw new PracticeError("RATE_LIMITED");
    }

    const questions = await store.getQuestions(quiz.id);
    if (questions.length === 0) throw new PracticeError("NOT_FOUND", "quiz has no questions");
    const attempt = await store.createAttempt(quiz.id, questions.length);
    return { attempt, questions: questions.map(toPublicQuestion) };
  });
}

// Marks a short answer on its meaning, using the model. An unusable reply is
// retried once; the answer is never accepted or rejected by guesswork.
async function evaluateShortAnswer(question: QuizQuestion, studentAnswer: string, deps: PracticeDeps) {
  const model = getModel(deps, PRACTICE.evaluationMaxOutputTokens, PRACTICE.evaluationEffort);
  const messages = buildEvaluationMessages({
    question: question.question,
    expectedAnswer: String(question.correctAnswer),
    acceptablePoints: question.acceptablePoints,
    sourceExcerpt: question.sourceExcerpt,
    studentAnswer,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = evaluationSchema.safeParse(parseModelJson(await completeChat(model, messages, "EVALUATION_FAILED")));
    if (parsed.success) return { result: parsed.data.verdict as AnswerResult, feedback: parsed.data.feedback };
  }
  throw new PracticeError("EVALUATION_FAILED", "evaluator reply did not match the schema");
}

export type AnswerInput = { attemptId?: unknown; questionId?: unknown; answer?: unknown };

// Checks one answer and stores it. The correct answer is only ever compared
// on the server; the browser learns it from the feedback returned here.
export async function answerQuestion(input: AnswerInput, deps: PracticeDeps): Promise<AnswerFeedback> {
  const store = await requireStore(deps);
  const { attemptId, questionId, answer } = input ?? {};
  if (!isUuid(attemptId) || !isUuid(questionId)) throw new PracticeError("NOT_FOUND", "malformed id");

  const { attempt, question, existing } = await db(async () => {
    const attempt = await store.getAttempt(attemptId);
    if (!attempt) throw new PracticeError("NOT_FOUND");
    // The question must belong to the quiz this attempt is for.
    const question = (await store.getQuestions(attempt.quizId)).find((item) => item.id === questionId);
    if (!question) throw new PracticeError("NOT_FOUND", "question is not part of this quiz");
    const existing = (await store.getAnswers(attempt.id)).find((item) => item.questionId === question.id);
    return { attempt, question, existing };
  });

  // Answers are final: asking again returns the first marking unchanged.
  if (existing) return toFeedback(question, existing);
  if (attempt.completedAt) throw new PracticeError("ATTEMPT_COMPLETED");

  let given: string | boolean;
  let result: AnswerResult;
  let feedback = "";

  if (question.type === "multiple_choice") {
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= question.options.length) {
      throw new PracticeError("INVALID_ANSWER", "not an option index");
    }
    given = question.options[answer];
    result = given === question.correctAnswer ? "correct" : "incorrect";
  } else if (question.type === "true_false") {
    if (typeof answer !== "boolean") throw new PracticeError("INVALID_ANSWER", "not a boolean");
    given = answer;
    result = answer === question.correctAnswer ? "correct" : "incorrect";
  } else {
    if (typeof answer !== "string") throw new PracticeError("INVALID_ANSWER", "not text");
    given = answer.trim().slice(0, PRACTICE.maxShortAnswerLength);
    if (!given) throw new PracticeError("EMPTY_ANSWER");
    ({ result, feedback } = await evaluateShortAnswer(question, given, deps));
  }

  const saved = await db(() =>
    store.saveAnswer({ attemptId: attempt.id, questionId: question.id, quizId: attempt.quizId, answer: given, result, feedback }),
  );
  return toFeedback(question, saved);
}

// The topics of this attempt that were not answered fully correctly, most
// missed first. This looks at one attempt only.
export function findWeakAreas(questions: QuizQuestion[], answers: QuizAnswer[]): QuizSummary["weakAreas"] {
  const results = new Map(answers.map((answer) => [answer.questionId, answer.result]));
  const topics = new Map<string, { topic: string; missed: number; total: number }>();

  for (const question of questions) {
    const key = normalizeText(question.topic) || "general";
    const entry = topics.get(key) ?? { topic: question.topic || "General", missed: 0, total: 0 };
    entry.total++;
    if (results.get(question.id) !== "correct") entry.missed++;
    topics.set(key, entry);
  }
  return [...topics.values()].filter((entry) => entry.missed > 0).sort((a, b) => b.missed - a.missed || b.total - a.total);
}

// The score of a set of answers: 1 for correct, half for partially correct.
export function scoreAnswers(answers: Pick<QuizAnswer, "result">[]) {
  return answers.reduce((sum, answer) => sum + (answer.result === "correct" ? 1 : answer.result === "partial" ? 0.5 : 0), 0);
}

// Finishes an attempt. The score is worked out from the stored answers;
// unanswered questions score nothing. Finishing twice changes nothing.
export async function completeAttempt(attemptId: unknown, deps: PracticeDeps): Promise<QuizSummary & { review: AnswerFeedback[] }> {
  const store = await requireStore(deps);
  if (!isUuid(attemptId)) throw new PracticeError("NOT_FOUND", "malformed id");

  return db(async () => {
    const attempt: QuizAttempt | null = await store.completeAttempt(attemptId);
    if (!attempt) throw new PracticeError("NOT_FOUND");

    const [questions, answers] = await Promise.all([store.getQuestions(attempt.quizId), store.getAnswers(attempt.id)]);
    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    return {
      attempt,
      weakAreas: findWeakAreas(questions, answers),
      review: questions.map((question) => toFeedback(question, byQuestion.get(question.id))),
    };
  });
}
