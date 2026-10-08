import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnswerResult,
  CardDraft,
  Difficulty,
  DifficultyChoice,
  Flashcard,
  FlashcardDeck,
  PracticeSource,
  QuestionDraft,
  QuestionType,
  Quiz,
  QuizAnswer,
  QuizAttempt,
  QuizQuestion,
  Rating,
} from "./types";

// Where quizzes and flashcards are kept. The quiz and flashcard flows depend
// on this interface only, so they can be tested with an in-memory stand-in.
//
// A store always acts for ONE signed-in user. Whatever the backend, it must
// behave as if other users' rows do not exist: lookups return null and
// writes are refused. The caller never passes a user id to choose whose data
// to use.
export interface PracticeStore {
  // Null for an unknown id and for another user's row alike, in every lookup.
  getSubject(id: string): Promise<{ id: string; name: string } | null>;
  getMaterial(id: string): Promise<{ id: string; title: string; subjectId: string; status: string } | null>;
  // Quizzes and decks this user has generated since a moment in time.
  countGenerationsSince(since: Date): Promise<number>;

  createQuiz(input: NewQuiz): Promise<Quiz>;
  getQuiz(id: string): Promise<Quiz | null>;
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(quizId: string, totalQuestions: number): Promise<QuizAttempt>;
  getAttempt(id: string): Promise<QuizAttempt | null>;
  countAttemptsSince(since: Date): Promise<number>;
  getAnswers(attemptId: string): Promise<QuizAnswer[]>;
  saveAnswer(input: NewAnswer): Promise<QuizAnswer>;
  // Works out the score from the stored answers and closes the attempt.
  completeAttempt(id: string): Promise<QuizAttempt | null>;

  createDeck(input: NewDeck): Promise<FlashcardDeck>;
  getCard(id: string): Promise<{ id: string; deckId: string } | null>;
  addReview(flashcardId: string, rating: Rating): Promise<{ id: string; reviewedAt: string }>;
}

export type NewQuiz = {
  title: string;
  mode: "quiz" | "practice";
  subjectId: string | null;
  materialId: string | null;
  difficulty: DifficultyChoice;
  questionTypes: QuestionType[];
  questions: QuestionDraft[];
};

export type NewAnswer = {
  attemptId: string;
  questionId: string;
  quizId: string;
  answer: string | boolean;
  result: AnswerResult;
  feedback: string;
};

export type NewDeck = { title: string; subjectId: string | null; materialId: string | null; cards: CardDraft[] };

// ------------------------------------------------------------- row mapping

export const QUIZ_COLUMNS = "id, title, mode, subject_id, material_id, difficulty, question_count, question_types, created_at";
export const QUESTION_COLUMNS = "id, position, question, question_type, options, correct_answer, explanation, sources, metadata";
export const ATTEMPT_COLUMNS = "id, quiz_id, score, total_questions, started_at, completed_at";
export const ANSWER_COLUMNS = "id, attempt_id, question_id, answer, result, evaluation, answered_at";
export const DECK_COLUMNS = "id, title, subject_id, material_id, created_at, updated_at";
export const CARD_COLUMNS = "id, position, front, back, source, difficulty";

type Row = Record<string, unknown>;

export function toQuiz(row: Row): Quiz {
  return {
    id: row.id as string,
    title: row.title as string,
    mode: row.mode as Quiz["mode"],
    subjectId: row.subject_id as string | null,
    materialId: row.material_id as string | null,
    difficulty: row.difficulty as DifficultyChoice,
    questionCount: row.question_count as number,
    questionTypes: row.question_types as QuestionType[],
    createdAt: row.created_at as string,
  };
}

export function toQuestion(row: Row): QuizQuestion {
  const metadata = (row.metadata ?? {}) as { topic?: string; difficulty?: Difficulty; acceptablePoints?: string[]; sourceExcerpt?: string; answerSource?: "official" | "ai_generated" };
  const sources = Array.isArray(row.sources) ? (row.sources as PracticeSource[]) : [];
  return {
    id: row.id as string,
    position: row.position as number,
    type: row.question_type as QuestionType,
    question: row.question as string,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    correctAnswer: row.correct_answer as string | boolean,
    acceptablePoints: metadata.acceptablePoints ?? [],
    explanation: row.explanation as string,
    topic: metadata.topic ?? "",
    difficulty: metadata.difficulty ?? "medium",
    source: sources[0] ?? null,
    sourceExcerpt: metadata.sourceExcerpt ?? "",
    ...(metadata.answerSource ? { answerSource: metadata.answerSource } : {}),
  };
}

export function toAttempt(row: Row): QuizAttempt {
  return {
    id: row.id as string,
    quizId: row.quiz_id as string,
    // numeric columns arrive as strings or numbers depending on the client.
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    totalQuestions: row.total_questions as number,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export function toAnswer(row: Row): QuizAnswer {
  const evaluation = (row.evaluation ?? {}) as { feedback?: string };
  return {
    id: row.id as string,
    attemptId: row.attempt_id as string,
    questionId: row.question_id as string,
    answer: row.answer as string | boolean,
    result: row.result as AnswerResult,
    feedback: evaluation.feedback ?? "",
    answeredAt: row.answered_at as string,
  };
}

export function toDeck(row: Row): FlashcardDeck {
  return {
    id: row.id as string,
    title: row.title as string,
    subjectId: row.subject_id as string | null,
    materialId: row.material_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function toCard(row: Row): Flashcard {
  return {
    id: row.id as string,
    position: row.position as number,
    front: row.front as string,
    back: row.back as string,
    difficulty: (row.difficulty as Difficulty | null) ?? "medium",
    source: (row.source as PracticeSource | null) ?? null,
  };
}

// Quizzes and flashcards in the app's own Supabase database, reached with
// the signed-in user's own client. Row Level Security is what limits every
// query to that user; the user_id filters state the intent and let Postgres
// use its indexes. user_id is never written: the database fills it in from
// the session, and clients have no privilege to set it.
export class SupabasePracticeStore implements PracticeStore {
  private readonly supabase: SupabaseClient;
  private readonly userId: string;

  constructor(supabase: SupabaseClient, userId: string) {
    this.supabase = supabase;
    this.userId = userId;
  }

  private async one(table: string, columns: string, id: string) {
    const { data, error } = await this.supabase.from(table).select(columns).eq("user_id", this.userId).eq("id", id).maybeSingle();
    if (error) throw new Error(`${table} select: ${error.code}`);
    return data as unknown as Row | null;
  }

  private async countSince(table: string, column: string, since: Date) {
    const { count, error } = await this.supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("user_id", this.userId)
      .gte(column, since.toISOString());
    if (error) throw new Error(`${table} count: ${error.code}`);
    return count ?? 0;
  }

  async getSubject(id: string) {
    return (await this.one("subjects", "id, name", id)) as { id: string; name: string } | null;
  }

  async getMaterial(id: string) {
    const row = await this.one("study_materials", "id, title, subject_id, processing_status", id);
    return row && { id: row.id as string, title: row.title as string, subjectId: row.subject_id as string, status: row.processing_status as string };
  }

  async countGenerationsSince(since: Date) {
    const [quizzes, decks] = await Promise.all([
      this.countSince("quizzes", "created_at", since),
      this.countSince("flashcard_decks", "created_at", since),
    ]);
    return quizzes + decks;
  }

  async createQuiz({ title, mode, subjectId, materialId, difficulty, questionTypes, questions }: NewQuiz) {
    const { data, error } = await this.supabase
      .from("quizzes")
      .insert({ title, mode, subject_id: subjectId, material_id: materialId, difficulty, question_count: questions.length, question_types: questionTypes })
      .select(QUIZ_COLUMNS)
      .single();
    if (error) throw new Error(`quizzes insert: ${error.code}`);
    const quiz = toQuiz(data as Row);

    const { error: questionsError } = await this.supabase.from("quiz_questions").insert(
      questions.map((question, position) => ({
        quiz_id: quiz.id,
        position,
        question: question.question,
        question_type: question.type,
        options: question.options,
        correct_answer: question.correctAnswer,
        explanation: question.explanation,
        sources: question.source ? [question.source] : [],
        metadata: {
          topic: question.topic,
          difficulty: question.difficulty,
          acceptablePoints: question.acceptablePoints,
          sourceExcerpt: question.sourceExcerpt,
        },
      })),
    );
    if (questionsError) {
      // A quiz with no questions is useless: take it back out.
      await this.supabase.from("quizzes").delete().eq("user_id", this.userId).eq("id", quiz.id);
      throw new Error(`quiz_questions insert: ${questionsError.code}`);
    }
    return quiz;
  }

  async getQuiz(id: string) {
    const row = await this.one("quizzes", QUIZ_COLUMNS, id);
    return row && toQuiz(row);
  }

  async getQuestions(quizId: string) {
    const { data, error } = await this.supabase
      .from("quiz_questions")
      .select(QUESTION_COLUMNS)
      .eq("user_id", this.userId)
      .eq("quiz_id", quizId)
      .order("position");
    if (error) throw new Error(`quiz_questions select: ${error.code}`);
    return (data as Row[]).map(toQuestion);
  }

  async createAttempt(quizId: string, totalQuestions: number) {
    const { data, error } = await this.supabase
      .from("quiz_attempts")
      .insert({ quiz_id: quizId, total_questions: totalQuestions })
      .select(ATTEMPT_COLUMNS)
      .single();
    if (error) throw new Error(`quiz_attempts insert: ${error.code}`);
    return toAttempt(data as Row);
  }

  async getAttempt(id: string) {
    const row = await this.one("quiz_attempts", ATTEMPT_COLUMNS, id);
    return row && toAttempt(row);
  }

  async countAttemptsSince(since: Date) {
    return this.countSince("quiz_attempts", "started_at", since);
  }

  async getAnswers(attemptId: string) {
    const { data, error } = await this.supabase
      .from("quiz_answers")
      .select(ANSWER_COLUMNS)
      .eq("user_id", this.userId)
      .eq("attempt_id", attemptId)
      .order("answered_at");
    if (error) throw new Error(`quiz_answers select: ${error.code}`);
    return (data as Row[]).map(toAnswer);
  }

  async saveAnswer({ attemptId, questionId, quizId, answer, result, feedback }: NewAnswer) {
    const { data, error } = await this.supabase
      .from("quiz_answers")
      .insert({
        attempt_id: attemptId,
        question_id: questionId,
        quiz_id: quizId,
        answer,
        is_correct: result === "correct",
        result,
        evaluation: feedback ? { feedback } : {},
      })
      .select(ANSWER_COLUMNS)
      .single();
    if (error) throw new Error(`quiz_answers insert: ${error.code}`);
    return toAnswer(data as Row);
  }

  async completeAttempt(id: string) {
    const { data, error } = await this.supabase.rpc("complete_quiz_attempt", { p_attempt_id: id });
    if (error) throw new Error(`complete_quiz_attempt: ${error.code}`);
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    return row?.id ? toAttempt(row) : null;
  }

  async createDeck({ title, subjectId, materialId, cards }: NewDeck) {
    const { data, error } = await this.supabase
      .from("flashcard_decks")
      .insert({ title, subject_id: subjectId, material_id: materialId })
      .select(DECK_COLUMNS)
      .single();
    if (error) throw new Error(`flashcard_decks insert: ${error.code}`);
    const deck = toDeck(data as Row);

    const { error: cardsError } = await this.supabase.from("flashcards").insert(
      cards.map((card, position) => ({ deck_id: deck.id, position, front: card.front, back: card.back, source: card.source, difficulty: card.difficulty })),
    );
    if (cardsError) {
      await this.supabase.from("flashcard_decks").delete().eq("user_id", this.userId).eq("id", deck.id);
      throw new Error(`flashcards insert: ${cardsError.code}`);
    }
    return deck;
  }

  async getCard(id: string) {
    const row = await this.one("flashcards", "id, deck_id", id);
    return row && { id: row.id as string, deckId: row.deck_id as string };
  }

  async addReview(flashcardId: string, rating: Rating) {
    const { data, error } = await this.supabase
      .from("flashcard_reviews")
      .insert({ flashcard_id: flashcardId, rating })
      .select("id, reviewed_at")
      .single();
    if (error) throw new Error(`flashcard_reviews insert: ${error.code}`);
    return { id: data.id as string, reviewedAt: data.reviewed_at as string };
  }
}
