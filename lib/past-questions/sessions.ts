import { DIFFICULTIES, PRACTICE } from "@/lib/ai/practice/config";
import { PracticeError, toPracticeError } from "@/lib/ai/practice/errors";
import type { AnswerResult, Difficulty, QuestionType, Quiz, QuizAnswer } from "@/lib/ai/practice/types";
import { isUuid } from "@/lib/library/files";
import { PAST, PAST_SELECTIONS, UNCATEGORIZED, type PastSelection } from "./config";
import type { PastStore, SessionQuestion } from "./store";
import type { ExamAttempt, ExamState, KnownAnswerSource, PastQuestion } from "./types";

// Practice sessions and exams made from a student's uploaded past questions.
//
// Both are stored as quizzes (lib/ai/practice): the chosen questions are
// copied into a quiz, and from there a practice session is taken with the
// ordinary quiz runner. An exam differs only in how it is sat: nothing is
// marked or revealed until it is submitted, and the marking is done by the
// store from the student's choices.
//
// Nothing here uses an AI model. Choosing questions, timing, marking and
// every figure in a result are plain code.

export type PastDeps = {
  // The signed-in user, from the verified session. Never from the request.
  getUser(): Promise<{ id: string } | null>;
  // A store acting for that user and no one else.
  openStore(userId: string): PastStore | Promise<PastStore>;
  // The student's current weak topics (lib/performance), for "Review weak topics".
  getWeakTopics?(): Promise<string[]>;
  now?(): Date;
  // For choosing questions at random. Injectable so tests are repeatable.
  random?(): number;
};

async function requireStore(deps: PastDeps) {
  const user = await deps.getUser();
  if (!user) throw new PracticeError("UNAUTHENTICATED");
  try {
    return await deps.openStore(user.id);
  } catch (error) {
    throw toPracticeError(error, "DATABASE_ERROR");
  }
}

async function db<T>(step: () => Promise<T>, fallback: "DATABASE_ERROR" | "EXAM_SUBMIT_FAILED" = "DATABASE_ERROR"): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw toPracticeError(error, fallback);
  }
}

export function normalizeTopic(topic: string | null) {
  return (topic ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function shuffle<T>(items: T[], random: () => number) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ------------------------------------------------------ choosing questions

export type SessionCriteria = {
  kind: "practice" | "exam";
  selection: PastSelection;
  // Null means "all available".
  count: number | null;
  year: number | null;
  topic: string | null;
  difficulty: Difficulty | null;
  // When set, only these past questions (a retry of earlier mistakes).
  only: Set<string> | null;
};

// A question can be practised when there is an answer to mark it against. An
// exam additionally needs questions that can be marked without judgement.
export function isPractisable(question: Pick<PastQuestion, "type" | "correctAnswer">, kind: "practice" | "exam") {
  if (question.type === "raw" || question.correctAnswer === null) return false;
  return kind === "practice" || question.type === "multiple_choice" || question.type === "true_false";
}

// Chooses the questions for a session. Pure: the same inputs always give the
// same questions. Throws the reason when nothing can be chosen.
export function selectQuestions<T extends PastQuestion>(
  pool: T[],
  criteria: SessionCriteria,
  context: { history: Map<string, AnswerResult>; weakTopics: string[]; random: () => number },
): T[] {
  const structured = pool.filter((question) => question.type !== "raw");
  if (structured.length === 0) throw new PracticeError("NO_PAST_QUESTIONS");
  let candidates = structured.filter((question) => isPractisable(question, criteria.kind));
  if (candidates.length === 0) throw new PracticeError("NO_ANSWERS_AVAILABLE");

  if (criteria.only) candidates = candidates.filter((question) => criteria.only!.has(question.id));
  if (criteria.year !== null) candidates = candidates.filter((question) => question.year === criteria.year);
  if (criteria.topic !== null) {
    const wanted = normalizeTopic(criteria.topic);
    candidates = candidates.filter((question) => normalizeTopic(question.topic ?? UNCATEGORIZED) === wanted);
  }
  if (criteria.difficulty !== null) {
    // Never pretend: with no ratings at all, say so instead of returning nothing.
    if (!candidates.some((question) => question.difficulty !== null)) throw new PracticeError("DIFFICULTY_UNAVAILABLE");
    candidates = candidates.filter((question) => question.difficulty === criteria.difficulty);
  }

  const { history } = context;
  if (criteria.selection === "unanswered") candidates = candidates.filter((question) => !history.has(question.id));
  if (criteria.selection === "missed") candidates = candidates.filter((question) => history.has(question.id) && history.get(question.id) !== "correct");
  if (criteria.selection === "weak_topics") {
    const weak = new Set(context.weakTopics.map(normalizeTopic));
    candidates = candidates.filter((question) => weak.has(normalizeTopic(question.topic)));
  }
  if (candidates.length === 0) throw new PracticeError("NO_MATCHING_QUESTIONS");

  const limit = Math.min(criteria.count ?? PAST.maxSessionQuestions, PAST.maxSessionQuestions);
  // An exam is the size that was asked for, or it is not started.
  if (criteria.kind === "exam" && criteria.count !== null && candidates.length < criteria.count) throw new PracticeError("NOT_ENOUGH_QUESTIONS", `${candidates.length} available`);

  // "All" keeps the paper's own order; every other choice is a random draw.
  const inOrder = criteria.selection === "all" || (criteria.kind === "exam" && criteria.count === null);
  return (inOrder ? candidates : shuffle(candidates, context.random)).slice(0, limit);
}

// ------------------------------------------------------ starting a session

export type PastSessionInput = {
  kind?: unknown;
  // Collections to draw from. Empty means every collection in scope.
  setIds?: unknown;
  subjectId?: unknown;
  year?: unknown;
  topic?: unknown;
  difficulty?: unknown;
  selection?: unknown;
  // A number, or "all".
  count?: unknown;
  // Exams only. Null or absent means no timer.
  timeLimitMinutes?: unknown;
  // Practise the questions missed in this earlier attempt.
  retryAttemptId?: unknown;
};

function parseInput(input: PastSessionInput) {
  const kind = input.kind === "exam" ? "exam" : "practice";

  let count: number | null;
  if (input.count === "all") count = null;
  else if (typeof input.count === "number" && (kind === "exam" ? PAST.examSizes : PAST.practiceSizes).includes(input.count)) count = input.count;
  else if (input.retryAttemptId && input.count === undefined) count = null;
  else throw new PracticeError("INVALID_REQUEST", "unsupported question count");

  const selection: PastSelection = kind === "exam" || input.selection === undefined ? "random" : (input.selection as PastSelection);
  if (!PAST_SELECTIONS.includes(selection)) throw new PracticeError("INVALID_REQUEST", "unsupported selection");

  let difficulty: Difficulty | null = null;
  if (input.difficulty && input.difficulty !== "mixed") {
    if (!DIFFICULTIES.includes(input.difficulty as Difficulty)) throw new PracticeError("INVALID_REQUEST", "unsupported difficulty");
    difficulty = input.difficulty as Difficulty;
  }

  let year: number | null = null;
  if (input.year !== undefined && input.year !== null && input.year !== "") {
    year = Number(input.year);
    if (!Number.isInteger(year) || year < PAST.minYear || year > PAST.maxYear) throw new PracticeError("INVALID_REQUEST", "unsupported year");
  }

  const topic = typeof input.topic === "string" && input.topic.trim() ? input.topic.replace(/\s+/g, " ").trim().slice(0, PAST.maxTopicLength) : null;

  // A timer only means something in an exam, and only within sane bounds: a
  // one-second or a week-long exam is refused rather than started.
  let timeLimitSeconds: number | null = null;
  if (kind === "exam" && input.timeLimitMinutes !== undefined && input.timeLimitMinutes !== null && input.timeLimitMinutes !== "") {
    const minutes = input.timeLimitMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < PAST.minCustomMinutes || minutes > PAST.maxCustomMinutes) {
      throw new PracticeError("INVALID_TIME_LIMIT");
    }
    timeLimitSeconds = minutes * 60;
  }

  const setIds = Array.isArray(input.setIds) ? input.setIds : input.setIds ? [input.setIds] : [];
  if (setIds.length > 50 || !setIds.every(isUuid)) throw new PracticeError("NOT_FOUND", "malformed collection id");
  const subjectId = input.subjectId || null;
  if (subjectId !== null && !isUuid(subjectId)) throw new PracticeError("SUBJECT_NOT_FOUND", "malformed id");
  const retryAttemptId = input.retryAttemptId || null;
  if (retryAttemptId !== null && !isUuid(retryAttemptId)) throw new PracticeError("NOT_FOUND", "malformed id");

  return { kind, count, selection, difficulty, year, topic, timeLimitSeconds, setIds: setIds as string[], subjectId, retryAttemptId } as const;
}

// Starts a practice session or an exam from the signed-in student's own past
// questions. Everything named in the request is looked up as that student;
// another student's collection is simply not found.
export async function createPastSession(input: PastSessionInput, deps: PastDeps): Promise<{ quiz: Quiz; attempt: ExamAttempt | null; delivered: number; requested: number | null }> {
  const store = await requireStore(deps);
  const settings = parseInput(input ?? {});
  const now = deps.now?.() ?? new Date();

  return db(async () => {
    const subject = settings.subjectId ? await store.getSubject(settings.subjectId) : null;
    if (settings.subjectId && !subject) throw new PracticeError("SUBJECT_NOT_FOUND");

    const allSets = (await store.listSets()).filter((set) => set.status === "ready");
    let sets = subject ? allSets.filter((set) => set.subjectId === subject.id) : allSets;
    if (settings.setIds.length > 0) {
      sets = sets.filter((set) => settings.setIds.includes(set.id));
      // Every named collection must be the student's own and ready.
      if (sets.length !== new Set(settings.setIds).size) throw new PracticeError("NOT_FOUND", "collection not found");
    }
    if (sets.length === 0) throw new PracticeError("NO_PAST_QUESTIONS");

    if ((await store.countAttemptsSince(new Date(now.getTime() - 60 * 60_000))) >= PRACTICE.attemptsPerHour) throw new PracticeError("RATE_LIMITED");

    // The questions an earlier attempt got wrong or left out.
    let only: Set<string> | null = null;
    if (settings.retryAttemptId) {
      const attempt = await store.getAttempt(settings.retryAttemptId);
      if (!attempt || !attempt.completedAt) throw new PracticeError("NOT_FOUND");
      const [questions, answers] = await Promise.all([store.getQuestions(attempt.quizId), store.getAnswers(attempt.id)]);
      const results = new Map(answers.map((answer) => [answer.questionId, answer.result]));
      only = new Set(questions.filter((question) => question.pastQuestionId && results.get(question.id) !== "correct").map((question) => question.pastQuestionId!));
    }

    const setById = new Map(sets.map((set) => [set.id, set]));
    const pool = (await store.listQuestions(sets.map((set) => set.id))).map((question) => ({
      ...question,
      // A question with no year of its own takes its collection's.
      year: question.year ?? setById.get(question.setId)?.year ?? null,
    }));

    const [history, weakTopics] = await Promise.all([
      settings.selection === "unanswered" || settings.selection === "missed" ? store.getHistory() : new Map<string, AnswerResult>(),
      settings.selection === "weak_topics" ? (deps.getWeakTopics?.() ?? []) : [],
    ]);
    const chosen = selectQuestions(pool, { ...settings, only }, { history, weakTopics, random: deps.random ?? Math.random });

    const subjectNames = new Map<string, string>();
    for (const subjectId of new Set(chosen.map((question) => setById.get(question.setId)!.subjectId))) {
      subjectNames.set(subjectId, (await store.getSubject(subjectId))?.name ?? "");
    }
    const usedSets = [...new Set(chosen.map((question) => question.setId))].map((id) => setById.get(id)!);
    const sessionSubjectId = subject?.id ?? (new Set(usedSets.map((set) => set.subjectId)).size === 1 ? usedSets[0].subjectId : null);
    const about = usedSets.length === 1 ? usedSets[0].title : sessionSubjectId ? `${subjectNames.get(sessionSubjectId) || "Subject"} past questions` : "Mixed past questions";
    const prefix = settings.kind === "exam" ? "Exam" : settings.retryAttemptId ? "Retry" : settings.selection === "missed" ? "My mistakes" : settings.selection === "weak_topics" ? "Weak topics" : "Practice";

    const quiz = await store.createSession({
      title: `${prefix}: ${about}`.slice(0, 150),
      mode: settings.kind === "exam" ? "exam" : "past_practice",
      subjectId: sessionSubjectId,
      setId: usedSets.length === 1 ? usedSets[0].id : null,
      difficulty: settings.difficulty ?? "mixed",
      questions: chosen.map((question) => {
        const set = setById.get(question.setId)!;
        return { ...question, setTitle: set.title, subjectName: subjectNames.get(set.subjectId) ?? "" };
      }),
    });

    // An exam's clock starts here, on the server, when it is created.
    const attempt = settings.kind === "exam" ? await store.createAttempt(quiz.id, chosen.length, settings.timeLimitSeconds) : null;
    return { quiz, attempt, delivered: chosen.length, requested: settings.count };
  });
}

// ------------------------------------------------------------ sitting an exam

// What the browser is given while an exam is open: the questions with no
// answers, explanations, topics or answer sources.
export type ExamQuestion = { id: string; position: number; type: QuestionType; question: string; options: string[] };

export function toExamQuestion({ id, position, type, question, options }: SessionQuestion): ExamQuestion {
  return { id, position, type, question, options };
}

// Seconds left on an exam's clock, or null when it is untimed.
export function secondsRemaining(attempt: Pick<ExamAttempt, "startedAt" | "timeLimitSeconds">, now: Date) {
  if (attempt.timeLimitSeconds === null) return null;
  return Math.max(0, Math.ceil(attempt.timeLimitSeconds - (now.getTime() - Date.parse(attempt.startedAt)) / 1000));
}

// Keeps only what an exam's state may contain, whatever was sent: choices
// for this exam's own questions, of the right kind, and nothing else. A
// score, a result or a "correct answer" in the request is simply dropped.
export function cleanExamState(input: unknown, questions: Pick<SessionQuestion, "id" | "type" | "options">[]): ExamState {
  const raw = (input ?? {}) as { answers?: unknown; flagged?: unknown };
  const given = raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers) ? (raw.answers as Record<string, unknown>) : {};
  const answers: ExamState["answers"] = {};

  for (const question of questions) {
    const value = given[question.id];
    if (question.type === "multiple_choice" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value < question.options.length) answers[question.id] = value;
    if (question.type === "true_false" && typeof value === "boolean") answers[question.id] = value;
  }

  const ids = new Set(questions.map((question) => question.id));
  const flagged = Array.isArray(raw.flagged) ? [...new Set(raw.flagged.filter((id): id is string => typeof id === "string" && ids.has(id)))] : [];
  return { answers, flagged };
}

export type ExamInput = { attemptId?: unknown; answers?: unknown; flagged?: unknown };

async function loadExam(store: PastStore, attemptId: unknown) {
  if (!isUuid(attemptId)) throw new PracticeError("EXAM_NOT_FOUND", "malformed id");
  const attempt = await store.getAttempt(attemptId);
  if (!attempt) throw new PracticeError("EXAM_NOT_FOUND");
  const quiz = await store.getQuiz(attempt.quizId);
  if (!quiz || quiz.mode !== "exam") throw new PracticeError("EXAM_NOT_FOUND", "not an exam");
  return { attempt, quiz, questions: await store.getQuestions(quiz.id) };
}

// Saves an open exam's answers so far. Nothing is marked and nothing is
// returned beyond whether it was saved.
export async function saveExamProgress(input: ExamInput, deps: PastDeps): Promise<{ saved: boolean }> {
  const store = await requireStore(deps);
  return db(async () => {
    const { attempt, questions } = await loadExam(store, input?.attemptId);
    if (attempt.completedAt) return { saved: false };
    return { saved: await store.saveProgress(attempt.id, cleanExamState(input, questions)) };
  });
}

// Submits an exam and returns its result. The request carries the student's
// choices and nothing else that is used: the score is worked out by the
// store from those choices and the stored correct answers.
export async function submitExam(input: ExamInput, deps: PastDeps): Promise<ExamReview> {
  const store = await requireStore(deps);
  return db(async () => {
    const { attempt, quiz, questions } = await loadExam(store, input?.attemptId);
    const submitted = attempt.completedAt ? attempt : await store.submitExam(attempt.id, cleanExamState(input, questions));
    if (!submitted) throw new PracticeError("EXAM_NOT_FOUND");
    return reviewExam(quiz, submitted, questions, await store.getAnswers(submitted.id));
  }, "EXAM_SUBMIT_FAILED");
}

// ------------------------------------------------------------------ results

export type ReviewQuestion = {
  id: string;
  position: number;
  number: string | null;
  type: QuestionType;
  question: string;
  options: string[];
  // Null when the question was left unanswered.
  answer: string | boolean | null;
  answerId: string | null;
  result: "correct" | "incorrect" | "unanswered";
  correctAnswer: string | boolean;
  // Whether the answer is the paper's own or Ari's.
  answerSource: KnownAnswerSource;
  explanation: string;
  explanationSource: KnownAnswerSource | null;
  topic: string;
  flagged: boolean;
};

export type Breakdown<K extends string> = { [key in K]: string } & { correct: number; total: number; accuracy: number };

export type ExamReview = {
  quiz: Quiz;
  attempt: ExamAttempt;
  totals: {
    total: number;
    answered: number;
    unanswered: number;
    correct: number;
    incorrect: number;
    // Correct out of every question, as a whole percentage.
    percent: number;
    // Correct out of the questions answered. Null when none were.
    accuracy: number | null;
    timeUsedSeconds: number | null;
    timeLimitSeconds: number | null;
    timeRemainingSeconds: number | null;
    // True when the exam was submitted after its time ran out.
    late: boolean;
  };
  topics: Breakdown<"topic">[];
  types: Breakdown<"type">[];
  // Only questions that carry a difficulty estimate are counted here.
  difficulties: Breakdown<"difficulty">[];
  questions: ReviewQuestion[];
  // Questions that can be practised again (missed or left out).
  retryable: number;
};

function breakdown<K extends string>(key: K, rows: { label: string; correct: boolean }[]): Breakdown<K>[] {
  const groups = new Map<string, { label: string; correct: number; total: number }>();
  for (const row of rows) {
    const id = row.label.toLowerCase();
    const group = groups.get(id) ?? { label: row.label, correct: 0, total: 0 };
    group.total++;
    if (row.correct) group.correct++;
    groups.set(id, group);
  }
  return [...groups.values()]
    .map(({ label, correct, total }) => ({ [key]: label, correct, total, accuracy: correct / total }) as Breakdown<K>)
    .sort((a, b) => b.total - a.total || String(a[key]).localeCompare(String(b[key])));
}

// Everything shown after an exam, worked out from the stored answers. Pure.
export function reviewExam(quiz: Quiz, attempt: ExamAttempt, questions: SessionQuestion[], answers: QuizAnswer[]): ExamReview {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const flagged = new Set(attempt.state.flagged);

  const reviewed: ReviewQuestion[] = questions.map((question) => {
    const answer = byQuestion.get(question.id);
    return {
      id: question.id,
      position: question.position,
      number: question.number,
      type: question.type,
      question: question.question,
      options: question.options,
      answer: answer?.answer ?? null,
      answerId: answer?.id ?? null,
      result: !answer ? "unanswered" : answer.result === "correct" ? "correct" : "incorrect",
      correctAnswer: question.correctAnswer,
      answerSource: question.answerSource ?? "official",
      explanation: question.explanation,
      explanationSource: question.explanationSource,
      topic: question.topic || UNCATEGORIZED,
      flagged: flagged.has(question.id),
    };
  });

  const total = reviewed.length;
  const correct = reviewed.filter((question) => question.result === "correct").length;
  const answered = reviewed.filter((question) => question.result !== "unanswered").length;
  const { timeLimitSeconds, timeUsedSeconds } = attempt;
  const difficultyOf = new Map(questions.map((question) => [question.id, question.estimatedDifficulty]));

  return {
    quiz,
    attempt,
    totals: {
      total,
      answered,
      unanswered: total - answered,
      correct,
      incorrect: answered - correct,
      percent: total > 0 ? Math.round((correct / total) * 100) : 0,
      accuracy: answered > 0 ? correct / answered : null,
      timeUsedSeconds,
      timeLimitSeconds,
      timeRemainingSeconds: timeLimitSeconds !== null && timeUsedSeconds !== null ? Math.max(0, timeLimitSeconds - timeUsedSeconds) : null,
      late: attempt.state.late === true,
    },
    topics: breakdown("topic", reviewed.map((question) => ({ label: question.topic, correct: question.result === "correct" }))),
    types: breakdown("type", reviewed.map((question) => ({ label: question.type, correct: question.result === "correct" }))),
    difficulties: breakdown(
      "difficulty",
      reviewed.filter((question) => difficultyOf.get(question.id)).map((question) => ({ label: difficultyOf.get(question.id)!, correct: question.result === "correct" })),
    ),
    questions: reviewed,
    retryable: questions.filter((question) => question.pastQuestionId && byQuestion.get(question.id)?.result !== "correct").length,
  };
}

// The result of a finished exam, for its owner. Before submission there is
// nothing to review, and this says so rather than revealing anything.
export async function getExamReview(attemptId: unknown, deps: PastDeps): Promise<ExamReview> {
  const store = await requireStore(deps);
  return db(async () => {
    const { attempt, quiz, questions } = await loadExam(store, attemptId);
    if (!attempt.completedAt) throw new PracticeError("EXAM_NOT_FOUND", "not submitted");
    return reviewExam(quiz, attempt, questions, await store.getAnswers(attempt.id));
  });
}
