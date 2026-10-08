// In-memory stand-ins for the quiz and flashcard database and the chat
// model, so generation, marking and scoring can be tested without network
// access.
import { randomUUID } from "node:crypto";
import { TutorError } from "@/lib/ai/tutor/errors";
import type { ChatMessage, TutorModel } from "@/lib/ai/tutor/provider";
import type { PracticeDeps } from "@/lib/ai/practice/generate";
import type { PracticeStore } from "@/lib/ai/practice/store";
import type { Flashcard, FlashcardDeck, Quiz, QuizAnswer, QuizAttempt, QuizQuestion, Rating } from "@/lib/ai/practice/types";
import { FakeKnowledgeBase } from "./tutor-fakes";

type Owned<T> = T & { userId: string };

// Every user's quizzes and flashcards in one place, the way one database
// holds them. `as(userId)` returns a store that behaves like the real one
// under Row Level Security: it finds only that user's rows and refuses to
// write into anyone else's. The real rules live in the database and are
// tested in supabase/tests/rls_practice.sql.
export class FakePracticeDb {
  subjects: Owned<{ id: string; name: string }>[] = [];
  materials: Owned<{ id: string; title: string; subjectId: string; status: string }>[] = [];
  quizzes: Owned<Quiz>[] = [];
  questions: Owned<QuizQuestion & { quizId: string }>[] = [];
  attempts: Owned<QuizAttempt>[] = [];
  answers: Owned<QuizAnswer>[] = [];
  decks: Owned<FlashcardDeck>[] = [];
  cards: Owned<Flashcard & { deckId: string }>[] = [];
  reviews: Owned<{ id: string; flashcardId: string; rating: Rating; reviewedAt: string }>[] = [];
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

  addMaterial(userId: string, subjectId: string, title: string, status = "ready") {
    const material = { id: randomUUID(), userId, subjectId, title, status };
    this.materials.push(material);
    return material;
  }

  as(userId: string): PracticeStore {
    const mine = <T extends { id: string; userId: string }>(rows: T[], id: string) => rows.find((row) => row.id === id && row.userId === userId) ?? null;
    const writable = () => {
      if (this.failWrites) throw new Error("insert: 08006 connection to db-internal.example failed");
    };

    return {
      getSubject: async (id) => {
        const subject = mine(this.subjects, id);
        return subject && { id: subject.id, name: subject.name };
      },
      getMaterial: async (id) => {
        const material = mine(this.materials, id);
        return material && { id: material.id, title: material.title, subjectId: material.subjectId, status: material.status };
      },
      countGenerationsSince: async (since) =>
        [...this.quizzes, ...this.decks].filter((row) => row.userId === userId && Date.parse(row.createdAt) >= since.getTime()).length,

      createQuiz: async ({ questions, ...settings }) => {
        writable();
        const quiz = { ...settings, id: randomUUID(), userId, questionCount: questions.length, createdAt: this.tick() };
        this.quizzes.push(quiz);
        questions.forEach((question, position) => this.questions.push({ ...question, id: randomUUID(), position, quizId: quiz.id, userId }));
        return quiz;
      },
      getQuiz: async (id) => mine(this.quizzes, id),
      getQuestions: async (quizId) => this.questions.filter((q) => q.quizId === quizId && q.userId === userId).sort((a, b) => a.position - b.position),
      createAttempt: async (quizId, totalQuestions) => {
        writable();
        // The foreign key: an attempt can only be at the user's own quiz.
        if (!mine(this.quizzes, quizId)) throw new Error("23503");
        const attempt = { id: randomUUID(), userId, quizId, score: null, totalQuestions, startedAt: this.tick(), completedAt: null };
        this.attempts.push(attempt);
        return attempt;
      },
      getAttempt: async (id) => mine(this.attempts, id),
      countAttemptsSince: async (since) => this.attempts.filter((a) => a.userId === userId && Date.parse(a.startedAt) >= since.getTime()).length,
      getAnswers: async (attemptId) => this.answers.filter((a) => a.attemptId === attemptId && a.userId === userId),
      saveAnswer: async ({ attemptId, questionId, quizId, answer, result, feedback }) => {
        writable();
        const attempt = mine(this.attempts, attemptId);
        const question = mine(this.questions, questionId);
        // The foreign keys and the insert policy.
        if (!attempt || !question || attempt.quizId !== quizId || question.quizId !== quizId) throw new Error("23503");
        if (attempt.completedAt) throw new Error("42501");
        // The restrictive policy: an exam's answers are written only when it is submitted.
        if (mine(this.quizzes, quizId)?.mode === "exam") throw new Error("42501");
        if (this.answers.some((a) => a.attemptId === attemptId && a.questionId === questionId)) throw new Error("23505");
        const saved = { id: randomUUID(), userId, attemptId, questionId, answer, result, feedback, answeredAt: this.tick() };
        this.answers.push(saved);
        return saved;
      },
      // Mirrors public.complete_quiz_attempt().
      completeAttempt: async (id) => {
        const attempt = mine(this.attempts, id);
        if (!attempt) return null;
        if (!attempt.completedAt) {
          const answers = this.answers.filter((a) => a.attemptId === id);
          attempt.score = answers.reduce((sum, a) => sum + (a.result === "correct" ? 1 : a.result === "partial" ? 0.5 : 0), 0);
          attempt.totalQuestions = this.questions.filter((q) => q.quizId === attempt.quizId).length;
          attempt.completedAt = this.tick();
        }
        return attempt;
      },

      createDeck: async ({ cards, ...settings }) => {
        writable();
        const at = this.tick();
        const deck = { ...settings, id: randomUUID(), userId, createdAt: at, updatedAt: at };
        this.decks.push(deck);
        cards.forEach((card, position) => this.cards.push({ ...card, id: randomUUID(), position, deckId: deck.id, userId }));
        return deck;
      },
      getCard: async (id) => {
        const card = mine(this.cards, id);
        return card && { id: card.id, deckId: card.deckId };
      },
      addReview: async (flashcardId, rating) => {
        writable();
        if (!mine(this.cards, flashcardId)) throw new Error("23503");
        const review = { id: randomUUID(), userId, flashcardId, rating, reviewedAt: this.tick() };
        this.reviews.push(review);
        return { id: review.id, reviewedAt: review.reviewedAt };
      },
    };
  }
}

// A chat model that returns prepared replies in order. Each call is
// recorded, with the output limit it was created with.
export class ScriptedModel implements TutorModel {
  readonly model = "scripted";
  calls: ChatMessage[][] = [];
  limits: (number | undefined)[] = [];
  replies: (string | object | Error)[] = [];
  // Used once the prepared replies run out.
  fallback: string | object = "not json";

  queue(...replies: (string | object | Error)[]) {
    this.replies.push(...replies);
    return this;
  }

  async streamChat(messages: ChatMessage[]) {
    this.calls.push(messages);
    const next = this.replies.length ? this.replies.shift()! : this.fallback;
    if (next instanceof Error) throw next;
    const text = typeof next === "string" ? next : JSON.stringify(next);
    return (async function* () {
      // In two pieces, the way a streamed reply arrives.
      yield text.slice(0, Math.ceil(text.length / 2));
      yield text.slice(Math.ceil(text.length / 2));
    })();
  }

  // The request sent in a given call: [system, user].
  prompt(call = this.calls.length - 1) {
    return this.calls[call].map((message) => message.content).join("\n\n");
  }
}

export type PracticeWorld = { db: FakePracticeDb; knowledge: FakeKnowledgeBase; model: ScriptedModel; configured: boolean };

export function practiceWorld(): PracticeWorld {
  return { db: new FakePracticeDb(), knowledge: new FakeKnowledgeBase(), model: new ScriptedModel(), configured: true };
}

// The dependencies of one request, all derived from the session, exactly as
// the Server Actions build them. `sessionUserId` null means signed out.
export function practiceDeps(w: PracticeWorld, sessionUserId: string | null): PracticeDeps {
  return {
    getUser: async () => (sessionUserId ? { id: sessionUserId } : null),
    openStore: (userId) => w.db.as(userId),
    search: w.knowledge.searchAs(sessionUserId ?? "signed-out"),
    // Mirrors inspectIndex(): what is really stored for this user in scope.
    inspect: async (scope) => {
      const userId = sessionUserId ?? "signed-out";
      const stored = w.knowledge.stored(userId, scope);
      return {
        readyMaterials: w.db.materials.filter((m) => m.userId === userId && m.status === "ready" && (!scope.subjectId || m.subjectId === scope.subjectId) && (!scope.materialId || m.id === scope.materialId)).length,
        chunks: stored.length,
        searchableChunks: stored.filter((c) => !w.knowledge.mislabelled.has(c.materialId)).length,
      };
    },
    browse: w.knowledge.browseAs(sessionUserId ?? "signed-out"),
    getModel: (options) => {
      if (!w.configured) throw new TutorError("NOT_CONFIGURED", "AI_API_KEY is not set");
      w.model.limits.push(options?.maxOutputTokens);
      return w.model;
    },
    now: () => w.db.now(),
    // No shuffling, so tests can predict where each option lands.
    random: () => 0.999,
  };
}

// ------------------------------------------------------- generated content

export const mcq = (question: string, source = 1, overrides: object = {}) => ({
  type: "multiple_choice",
  question,
  options: ["The cornea", "The lens", "The retina", "The iris"],
  correctIndex: 0,
  explanation: "The cornea provides most of the eye's focusing power because of the large change in refractive index at its surface.",
  topic: "Refraction",
  difficulty: "medium",
  source,
  ...overrides,
});

export const trueFalse = (question: string, correctAnswer: boolean, source = 1, overrides: object = {}) => ({
  type: "true_false",
  question,
  correctAnswer,
  explanation: "The material states this directly.",
  topic: "Accommodation",
  difficulty: "easy",
  source,
  ...overrides,
});

export const shortAnswer = (question: string, source = 1, overrides: object = {}) => ({
  type: "short_answer",
  question,
  expectedAnswer: "The ciliary muscle contracts, the zonules slacken and the lens becomes more convex.",
  acceptablePoints: ["ciliary muscle contracts", "lens becomes more convex"],
  explanation: "Accommodation increases the power of the lens for near vision.",
  topic: "Accommodation",
  difficulty: "hard",
  source,
  ...overrides,
});

export const card = (front: string, back: string, source = 1, overrides: object = {}) => ({ front, back, difficulty: "easy", source, ...overrides });
