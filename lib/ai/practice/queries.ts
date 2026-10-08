import "server-only";

import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { browseChunks, inspectIndex } from "@/lib/ai/retrieval/index-health";
import { searchKnowledgeBase } from "@/lib/ai/retrieval/search";
import { getTutorModel } from "@/lib/ai/tutor/provider";
import { getCurrentUser } from "@/lib/auth/dal";
import type { MaterialOption } from "@/components/practice/scope-fields";
import { findTypeByExtension, isUuid } from "@/lib/library/files";
import { getMaterials, getSubjects } from "@/lib/library/queries";
import type { SubjectOption } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";
import { buildExplainMessage } from "./explain";
import type { PracticeDeps } from "./generate";
import { findWeakAreas, toFeedback, toPublicQuestion } from "./quiz-service";
import {
  ANSWER_COLUMNS,
  ATTEMPT_COLUMNS,
  CARD_COLUMNS,
  DECK_COLUMNS,
  QUESTION_COLUMNS,
  QUIZ_COLUMNS,
  SupabasePracticeStore,
  toAnswer,
  toAttempt,
  toCard,
  toDeck,
  toQuestion,
  toQuiz,
} from "./store";
import type { AnswerFeedback, Flashcard, FlashcardDeck, PublicQuestion, Quiz, QuizAttempt, QuizSummary } from "./types";

// The real session, database, search and model for quiz and flashcard
// operations. Everything is derived from the signed-in user's session, and
// the model is the tutor's: there is no second AI integration.
export function practiceDeps(): PracticeDeps {
  return {
    getUser: getCurrentUser,
    openStore: async (userId) => new SupabasePracticeStore(await createClient(), userId),
    search: searchKnowledgeBase,
    getModel: getTutorModel,
    // Both look only at the signed-in user's own index: the user comes from
    // the session, and Row Level Security applies to every query.
    inspect: async (scope) => {
      const user = await getCurrentUser();
      if (!user) throw new Error("not signed in");
      return inspectIndex(await createClient(), user.id, scope, currentEmbeddingModel());
    },
    browse: async (scope, limit) => {
      const user = await getCurrentUser();
      if (!user) throw new Error("not signed in");
      return browseChunks(await createClient(), user.id, scope, limit);
    },
  };
}

// The embedding model searches are made with, or null if none is configured.
export function currentEmbeddingModel() {
  try {
    return getEmbeddingProvider().model;
  } catch {
    return null;
  }
}

// Every query below runs as the signed-in user, so Row Level Security limits
// the results to that user's rows. The explicit user_id filters state the
// intent and let Postgres use the user_id indexes.

type Row = Record<string, unknown>;

export type QuizListItem = Quiz & {
  attempts: number;
  // The most recent finished attempt, if any.
  lastCompleted: QuizAttempt | null;
  inProgress: boolean;
};

export async function getQuizList(): Promise<QuizListItem[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("quizzes")
    .select(`${QUIZ_COLUMNS}, quiz_attempts(${ATTEMPT_COLUMNS})`)
    .eq("user_id", user.id)
    // Sessions made from past questions are listed on their own pages.
    .in("mode", ["quiz", "practice"])
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) {
    console.error("[practice] quizzes load failed", { code: error.code });
    throw new Error("Could not load quizzes.");
  }

  return (data as unknown as (Row & { quiz_attempts: Row[] })[]).map((row) => {
    const attempts = row.quiz_attempts.map(toAttempt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      ...toQuiz(row),
      attempts: attempts.length,
      lastCompleted: attempts.find((attempt) => attempt.completedAt) ?? null,
      inProgress: Boolean(attempts[0] && !attempts[0].completedAt),
    };
  });
}

export type QuizPage = {
  quiz: Quiz;
  questions: PublicQuestion[];
  // The most recent attempt, or null if the quiz has not been started.
  attempt: QuizAttempt | null;
  // Feedback for the questions already answered. For a finished attempt,
  // feedback for every question.
  feedback: AnswerFeedback[];
  summary: QuizSummary | null;
};

// Returns null when the quiz does not exist OR belongs to someone else. The
// two cases are deliberately indistinguishable to the caller.
//
// Correct answers and explanations are only included for questions that
// have been answered (or for all of them once the attempt is finished).
export async function getQuizPage(id: string): Promise<QuizPage | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(id)) return null;

  const supabase = await createClient();
  const [quizResult, questionsResult, attemptResult] = await Promise.all([
    supabase.from("quizzes").select(QUIZ_COLUMNS).eq("user_id", user.id).eq("id", id).maybeSingle(),
    supabase.from("quiz_questions").select(QUESTION_COLUMNS).eq("user_id", user.id).eq("quiz_id", id).order("position"),
    supabase.from("quiz_attempts").select(ATTEMPT_COLUMNS).eq("user_id", user.id).eq("quiz_id", id).order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const failed = quizResult.error ?? questionsResult.error ?? attemptResult.error;
  if (failed) {
    console.error("[practice] quiz load failed", { code: failed.code });
    throw new Error("Could not load the quiz.");
  }
  // An exam has its own page, which shows nothing until it is submitted.
  if (!quizResult.data || quizResult.data.mode === "exam") return null;

  const questions = (questionsResult.data as Row[]).map(toQuestion);
  const attempt = attemptResult.data ? toAttempt(attemptResult.data as Row) : null;

  let feedback: AnswerFeedback[] = [];
  let summary: QuizSummary | null = null;
  if (attempt) {
    const { data, error } = await supabase.from("quiz_answers").select(ANSWER_COLUMNS).eq("user_id", user.id).eq("attempt_id", attempt.id);
    if (error) {
      console.error("[practice] answers load failed", { code: error.code });
      throw new Error("Could not load the quiz.");
    }
    const answers = (data as Row[]).map(toAnswer);
    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

    if (attempt.completedAt) {
      feedback = questions.map((question) => toFeedback(question, byQuestion.get(question.id)));
      summary = { attempt, weakAreas: findWeakAreas(questions, answers) };
    } else {
      feedback = questions.filter((question) => byQuestion.has(question.id)).map((question) => toFeedback(question, byQuestion.get(question.id)));
    }
  }

  return { quiz: toQuiz(quizResult.data as Row), questions: questions.map(toPublicQuestion), attempt, feedback, summary };
}

export type DeckListItem = FlashcardDeck & { cards: number };

export async function getDeckList(): Promise<DeckListItem[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("flashcard_decks")
    .select(`${DECK_COLUMNS}, flashcards(count)`)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(60);

  if (error) {
    console.error("[practice] decks load failed", { code: error.code });
    throw new Error("Could not load flashcard decks.");
  }
  return (data as unknown as (Row & { flashcards: { count: number }[] })[]).map((row) => ({ ...toDeck(row), cards: row.flashcards[0]?.count ?? 0 }));
}

// Returns null when the deck does not exist OR belongs to someone else.
export async function getDeckPage(id: string): Promise<{ deck: FlashcardDeck; cards: Flashcard[] } | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(id)) return null;

  const supabase = await createClient();
  const [deckResult, cardsResult] = await Promise.all([
    supabase.from("flashcard_decks").select(DECK_COLUMNS).eq("user_id", user.id).eq("id", id).maybeSingle(),
    supabase.from("flashcards").select(CARD_COLUMNS).eq("user_id", user.id).eq("deck_id", id).order("position"),
  ]);

  const failed = deckResult.error ?? cardsResult.error;
  if (failed) {
    console.error("[practice] deck load failed", { code: failed.code });
    throw new Error("Could not load the deck.");
  }
  if (!deckResult.data) return null;
  return { deck: toDeck(deckResult.data as Row), cards: (cardsResult.data as Row[]).map(toCard) };
}

// The tutor message for "Ask Ari to explain" on one of the student's own
// answers, with the subject to search. Null for an unknown answer and for
// another user's answer alike.
export async function getExplainRequest(answerId: string): Promise<{ message: string; subjectId: string | null } | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(answerId)) return null;

  const supabase = await createClient();
  const { data: answerRow, error } = await supabase.from("quiz_answers").select(`${ANSWER_COLUMNS}, quiz_id`).eq("user_id", user.id).eq("id", answerId).maybeSingle();
  if (error || !answerRow) return null;

  const row = answerRow as unknown as Row;
  const [questionResult, quizResult] = await Promise.all([
    supabase.from("quiz_questions").select(QUESTION_COLUMNS).eq("user_id", user.id).eq("id", row.question_id as string).maybeSingle(),
    supabase.from("quizzes").select("subject_id").eq("user_id", user.id).eq("id", row.quiz_id as string).maybeSingle(),
  ]);
  if (questionResult.error || !questionResult.data) return null;

  const question = toQuestion(questionResult.data as Row);
  return {
    message: buildExplainMessage(question, toFeedback(question, toAnswer(row))),
    subjectId: (quizResult.data?.subject_id as string | null | undefined) ?? null,
  };
}

// The subjects and processed materials a student can practise from. Only
// materials that are "Ready for Ari" are offered: the others have nothing in
// the knowledge base to write questions from.
export async function getPracticeOptions(): Promise<{ subjects: SubjectOption[]; materials: MaterialOption[] }> {
  const [subjects, materials] = await Promise.all([getSubjects(), getMaterials()]);
  return {
    subjects: subjects.map(({ id, name, color, icon }) => ({ id, name, color, icon })),
    materials: materials
      .filter((material) => material.processing_status === "ready")
      .map((material) => ({
        id: material.id,
        title: material.title,
        subjectId: material.subject_id,
        kind: findTypeByExtension(material.file_extension ?? "")?.label ?? (material.file_extension ?? "file").toUpperCase(),
      })),
  };
}
