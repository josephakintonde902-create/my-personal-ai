// In-memory stand-ins for the past-question tables and the exam functions,
// so reading papers, choosing questions, sitting exams and marking them can
// be tested without a database or a network.
import { randomUUID } from "node:crypto";
import type { PracticeDeps } from "@/lib/ai/practice/generate";
import type { QuestionType } from "@/lib/ai/practice/types";
import { TutorError } from "@/lib/ai/tutor/errors";
import { PAST } from "@/lib/past-questions/config";
import type { PastProcessingDeps } from "@/lib/past-questions/process";
import type { PastDeps } from "@/lib/past-questions/sessions";
import { NO_EXPLANATION, type PaperToProcess, type PastProcessingStore, type PastStore, type SessionQuestion } from "@/lib/past-questions/store";
import type { ExamAttempt, PastQuestion, PastQuestionSet } from "@/lib/past-questions/types";
import { FakePracticeDb, practiceDeps, ScriptedModel } from "./practice-fakes";
import { FakeKnowledgeBase } from "./tutor-fakes";

type Owned<T> = T & { userId: string };

// A copy of a row without the columns a query would not select.
function omit<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}
type StoredSet = Owned<PastQuestionSet & { bytes: Uint8Array; typeId: string }>;

// Every user's past questions in one place, the way one database holds them.
// Sessions, attempts and answers go into the SAME tables the quiz fakes use
// (`quizzes`), because that is where the real ones go: a practice session
// made here is then taken with the ordinary quiz service.
//
// `as(userId)` returns a store that behaves like the real one under Row
// Level Security: it finds only that user's rows. The real rules live in the
// database and are tested in supabase/tests/rls_past_questions.sql.
export class FakePastDb {
  readonly quizzes: FakePracticeDb;
  sets: StoredSet[] = [];
  questions: Owned<PastQuestion>[] = [];
  // quiz id → the collection it was drawn from.
  sessionSets = new Map<string, string | null>();
  clock = Date.parse("2026-10-08T09:00:00.000Z");

  constructor(quizzes = new FakePracticeDb()) {
    this.quizzes = quizzes;
  }

  now() {
    return new Date(this.clock);
  }

  advance(seconds: number) {
    this.clock += seconds * 1000;
  }

  addSubject(userId: string, name: string) {
    return this.quizzes.addSubject(userId, name);
  }

  // An uploaded paper, not yet read.
  addPaper(userId: string, subjectId: string, title: string, content: string | Uint8Array, typeId = "txt", year: number | null = null) {
    const set: StoredSet = {
      id: randomUUID(), userId, subjectId, title, examType: null, institution: null, year, courseCode: null, description: null,
      originalFilename: `${title}.${typeId}`, fileExtension: typeId, status: "pending", error: null, processingStartedAt: null,
      analysisStatus: "pending", createdAt: this.now().toISOString(),
      bytes: typeof content === "string" ? new TextEncoder().encode(content) : content, typeId,
    };
    this.sets.push(set);
    return set;
  }

  // A collection that has already been read, with these questions in it.
  addSet(userId: string, subjectId: string, title: string, questions: Partial<PastQuestion>[], year: number | null = null) {
    const set = this.addPaper(userId, subjectId, title, "", "txt", year);
    set.status = "ready";
    questions.forEach((question, position) => this.questions.push(pastQuestion({ ...question, setId: set.id, position }, userId)));
    return set;
  }

  questionsOf(setId: string) {
    return this.questions.filter((question) => question.setId === setId).sort((a, b) => a.position - b.position);
  }

  as(userId: string): PastStore & PastProcessingStore {
    const db = this.quizzes;
    const mine = <T extends { id: string; userId: string }>(rows: T[], id: string) => rows.find((row) => row.id === id && row.userId === userId) ?? null;
    const strip = (set: StoredSet): PastQuestionSet => omit(set, "bytes", "typeId", "userId");
    const attemptOf = (id: string) => mine(db.attempts, id) as Owned<ExamAttempt> | null;
    const isExam = (quizId: string) => mine(db.quizzes, quizId)?.mode === "exam";
    const elapsed = (attempt: ExamAttempt) => Math.max(0, Math.floor((this.clock - Date.parse(attempt.startedAt)) / 1000));
    const outOfTime = (attempt: ExamAttempt) => attempt.timeLimitSeconds !== null && elapsed(attempt) > attempt.timeLimitSeconds + PAST.graceSeconds;

    return {
      getSubject: async (id) => {
        const subject = mine(db.subjects, id);
        return subject && { id: subject.id, name: subject.name };
      },
      getSet: async (id) => {
        const set = mine(this.sets, id);
        return set && strip(set);
      },
      listSets: async () => this.sets.filter((set) => set.userId === userId).map(strip),
      listQuestions: async (setIds) =>
        this.questions
          .filter((question) => question.userId === userId && setIds.includes(question.setId))
          .sort((a, b) => a.setId.localeCompare(b.setId) || a.position - b.position)
          .map((question) => omit(question, "userId")),
      getHistory: async () => {
        const source = new Map(db.questions.filter((q) => q.userId === userId).map((q) => [q.id, (q as unknown as SessionQuestion).pastQuestionId]));
        const history = new Map();
        for (const answer of db.answers.filter((a) => a.userId === userId).sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))) {
          const pastQuestionId = source.get(answer.questionId);
          if (pastQuestionId && !history.has(pastQuestionId)) history.set(pastQuestionId, answer.result);
        }
        return history;
      },
      countAttemptsSince: async (since) => db.attempts.filter((a) => a.userId === userId && Date.parse(a.startedAt) >= since.getTime()).length,

      createSession: async ({ title, mode, subjectId, setId, difficulty, questions }) => {
        if (db.failWrites) throw new Error("insert: 08006 connection to db-internal.example failed");
        // The foreign keys: a session can only point at the user's own rows.
        if ((subjectId && !mine(db.subjects, subjectId)) || (setId && !mine(this.sets, setId))) throw new Error("23503");
        const quiz = {
          id: randomUUID(), userId, title, mode, subjectId, materialId: null, difficulty, questionCount: questions.length,
          questionTypes: [...new Set(questions.map((q) => q.type))] as QuestionType[], createdAt: this.now().toISOString(),
        };
        db.quizzes.push(quiz);
        this.sessionSets.set(quiz.id, setId);
        questions.forEach((question, position) => {
          if (!mine(this.questions, question.id)) throw new Error("23503");
          const copy: Owned<SessionQuestion & { quizId: string }> = {
            id: randomUUID(), userId, quizId: quiz.id, position, type: question.type as QuestionType, question: question.question, options: question.options,
            correctAnswer: question.correctAnswer!, acceptablePoints: [], explanation: question.explanation ?? NO_EXPLANATION, topic: question.topic ?? "",
            difficulty: question.difficulty ?? "medium", estimatedDifficulty: question.difficulty,
            source: { n: 1, materialId: question.setId, title: question.setTitle, subject: question.subjectName, page: question.page, slide: question.slide, section: null },
            sourceExcerpt: "", answerSource: question.answerSource === "ai_generated" ? "ai_generated" : "official",
            pastQuestionId: question.id, number: question.number, explanationSource: question.explanation ? question.explanationSource : null,
          };
          db.questions.push(copy);
        });
        return quiz;
      },
      createAttempt: async (quizId, totalQuestions, timeLimitSeconds) => {
        if (db.failWrites) throw new Error("insert: 08006");
        if (!mine(db.quizzes, quizId)) throw new Error("23503");
        const attempt: Owned<ExamAttempt> = {
          id: randomUUID(), userId, quizId, score: null, totalQuestions, startedAt: this.now().toISOString(), completedAt: null,
          timeLimitSeconds, timeUsedSeconds: null, state: { answers: {}, flagged: [] },
        };
        db.attempts.push(attempt);
        return attempt;
      },
      getQuiz: async (id) => mine(db.quizzes, id),
      getAttempt: async (id) => attemptOf(id),
      getQuestions: async (quizId) =>
        (db.questions.filter((q) => q.quizId === quizId && q.userId === userId) as unknown as Owned<SessionQuestion>[]).sort((a, b) => a.position - b.position),
      getAnswers: async (attemptId) => db.answers.filter((a) => a.attemptId === attemptId && a.userId === userId),

      // Mirrors public.save_exam_progress().
      saveProgress: async (attemptId, state) => {
        const attempt = attemptOf(attemptId);
        if (!attempt || attempt.completedAt || !isExam(attempt.quizId) || outOfTime(attempt)) return false;
        attempt.state = { answers: { ...state.answers }, flagged: [...state.flagged] };
        return true;
      },
      // Mirrors public.submit_exam_attempt(): the marking happens here, from
      // the choices alone.
      submitExam: async (attemptId, state) => {
        if (db.failWrites) throw new Error("rpc: 08006 connection to db-internal.example failed");
        const attempt = attemptOf(attemptId);
        if (!attempt || !isExam(attempt.quizId)) return null;
        if (attempt.completedAt) return attempt;

        const late = outOfTime(attempt);
        const used = late ? attempt.state : state;
        const questions = db.questions.filter((q) => q.quizId === attempt.quizId && q.userId === userId);
        let score = 0;
        for (const question of questions) {
          const value = used.answers[question.id];
          let given: string | boolean | undefined;
          if (question.type === "multiple_choice" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value < question.options.length) given = question.options[value];
          if (question.type === "true_false" && typeof value === "boolean") given = value;
          if (given === undefined) continue;
          const correct = given === question.correctAnswer;
          if (correct) score++;
          db.answers.push({ id: randomUUID(), userId, attemptId, questionId: question.id, answer: given, result: correct ? "correct" : "incorrect", feedback: "", answeredAt: this.now().toISOString() });
        }
        attempt.completedAt = this.now().toISOString();
        attempt.score = score;
        attempt.totalQuestions = questions.length;
        attempt.timeUsedSeconds = attempt.timeLimitSeconds === null ? elapsed(attempt) : Math.min(elapsed(attempt), attempt.timeLimitSeconds);
        attempt.state = { answers: {}, flagged: [...used.flagged], late };
        return attempt;
      },

      // ------------------------------------------------------- processing
      claim: async (setId) => {
        const set = mine(this.sets, setId);
        if (!set || set.status === "processing") return null;
        set.status = "processing";
        set.error = null;
        set.processingStartedAt = this.now().toISOString();
        return { id: set.id, subjectId: set.subjectId, filePath: `${userId}/${set.subjectId}/${set.id}/paper.${set.typeId}`, mimeType: "", typeId: set.typeId, year: set.year };
      },
      download: async (paper: PaperToProcess) => mine(this.sets, paper.id)!.bytes,
      replaceQuestions: async (setId, questions) => {
        if (!mine(this.sets, setId)) throw new Error("23503");
        this.questions = this.questions.filter((question) => question.setId !== setId);
        questions.forEach((question, position) =>
          this.questions.push(
            pastQuestion(
              {
                setId, position, number: question.number, type: question.type, question: question.question, options: question.options,
                correctAnswer: question.correctAnswer, answerSource: question.correctAnswer === null ? "answer_unavailable" : "official",
                explanation: question.explanation, explanationSource: question.explanation ? "official" : null, year: question.year, page: question.page, slide: question.slide,
              },
              userId,
            ),
          ),
        );
      },
      finish: async (setId) => {
        const set = mine(this.sets, setId)!;
        set.status = "ready";
        set.analysisStatus = "pending";
      },
      fail: async (setId, message) => {
        const set = mine(this.sets, setId)!;
        set.status = "failed";
        set.error = message;
      },
      knownTopics: async (subjectId) => {
        const setIds = new Set(this.sets.filter((set) => set.userId === userId && set.subjectId === subjectId).map((set) => set.id));
        return [...new Set(this.questions.filter((q) => setIds.has(q.setId) && q.topic && q.topic !== "Uncategorized").map((q) => q.topic!))];
      },
      listUnanalyzed: async (setId, limit) =>
        this.questions.filter((q) => q.userId === userId && q.setId === setId && q.type !== "raw" && !q.analyzed).sort((a, b) => a.position - b.position).slice(0, limit),
      applyAnalysis: async (updates) => {
        for (const update of updates) {
          const question = mine(this.questions, update.id);
          if (!question) continue;
          question.topic = update.topic;
          question.difficulty = update.difficulty;
          question.analyzed = true;
          // The trigger: only a question with no answer of its own gets Ari's.
          if (update.answer !== undefined && question.answerSource === "answer_unavailable") {
            question.correctAnswer = update.answer;
            question.answerSource = "ai_generated";
            if (update.explanation) {
              question.explanation = update.explanation;
              question.explanationSource = "ai_generated";
            }
          }
        }
      },
      setAnalysisStatus: async (setId, status) => {
        const set = mine(this.sets, setId);
        if (set) set.analysisStatus = status;
      },
    };
  }
}

let counter = 0;

export function pastQuestion(overrides: Partial<PastQuestion>, userId: string): Owned<PastQuestion> {
  counter++;
  const type = overrides.type ?? "multiple_choice";
  const options = overrides.options ?? (type === "multiple_choice" ? ["Alpha", "Beta", "Gamma", "Delta"] : []);
  const correctAnswer = overrides.correctAnswer === undefined ? (type === "multiple_choice" ? options[0] : type === "true_false" ? true : "A model answer.") : overrides.correctAnswer;
  return {
    id: randomUUID(), userId, setId: "", position: 0, number: String(counter), type, question: `Question ${counter} about the topic?`, options,
    explanation: null, explanationSource: null, year: null, topic: null, difficulty: null, analyzed: false, page: null, slide: null,
    ...overrides,
    correctAnswer,
    answerSource: overrides.answerSource ?? (correctAnswer === null ? "answer_unavailable" : "official"),
  };
}

export type PastWorld = { db: FakePastDb; model: ScriptedModel; configured: boolean; weakTopics: string[]; random: () => number };

export function pastWorld(): PastWorld {
  // No shuffling by default, so tests can predict what is chosen.
  return { db: new FakePastDb(), model: new ScriptedModel(), configured: true, weakTopics: [], random: () => 0.999 };
}

// The dependencies of one request, all derived from the session, exactly as
// the Server Actions build them. `sessionUserId` null means signed out.
export function pastDeps(w: PastWorld, sessionUserId: string | null): PastDeps {
  return {
    getUser: async () => (sessionUserId ? { id: sessionUserId } : null),
    openStore: (userId) => w.db.as(userId),
    getWeakTopics: async () => w.weakTopics,
    now: () => w.db.now(),
    random: w.random,
  };
}

export function processingDeps(w: PastWorld, userId: string): PastProcessingDeps {
  return {
    store: w.db.as(userId),
    getModel: (options) => {
      if (!w.configured) throw new TutorError("NOT_CONFIGURED", "GEMINI_API_KEY is not set");
      w.model.limits.push(options?.maxOutputTokens);
      return w.model;
    },
    now: () => w.db.clock,
  };
}

// The ordinary quiz service's dependencies, over the same tables.
export function quizDeps(w: PastWorld, sessionUserId: string | null): PracticeDeps {
  return practiceDeps({ db: w.db.quizzes, knowledge: new FakeKnowledgeBase(), model: w.model, configured: w.configured }, sessionUserId);
}
