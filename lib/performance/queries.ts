import "server-only";

import type { AnswerResult, Difficulty, QuestionType, Rating } from "@/lib/ai/practice/types";
import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { computePerformance, type Performance, type QuizRecord } from "./compute";
import { PERFORMANCE } from "./config";
import { computeReadiness, type Readiness } from "./readiness";

// Loads the signed-in student's own records and works their performance out
// from them. There are no stored statistics: the answers, attempts and
// reviews are the source of truth, and every figure is recalculated from
// them on each visit.
//
// There is no user parameter. The student is the session's user, every query
// runs as that user under Row Level Security, and the explicit user_id
// filters state the intent and let Postgres use the per-user indexes.

export type PerformanceReport = Performance & {
  // The wording of the questions missed more than once.
  repeatedQuestions: { questionId: string; question: string; topic: string | null; misses: number; attempts: number }[];
  // Exam readiness, worked out from the same records (lib/performance/readiness.ts).
  readiness: Readiness;
};

type AnswerRow = { question_id: string; quiz_id: string; result: AnswerResult; answered_at: string };
type QuestionRow = { id: string; question_type: QuestionType; topic: string | null; difficulty: Difficulty | null };
type AttemptRow = { id: string; quiz_id: string; score: number | string | null; total_questions: number; completed_at: string };

export async function getPerformance(): Promise<PerformanceReport | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const [answers, questions, attempts, quizzes, subjects, reviews, reviewsTotal, pastTopics] = await Promise.all([
    supabase
      .from("quiz_answers")
      .select("question_id, quiz_id, result, answered_at")
      .eq("user_id", user.id)
      .order("answered_at", { ascending: false })
      .limit(PERFORMANCE.maxAnswers),
    // Only what is needed to group answers; not the questions' text, answers
    // or source passages.
    supabase
      .from("quiz_questions")
      .select("id, question_type, topic:metadata->>topic, difficulty:metadata->>difficulty")
      .eq("user_id", user.id)
      .limit(PERFORMANCE.maxAnswers),
    supabase
      .from("quiz_attempts")
      .select("id, quiz_id, score, total_questions, completed_at")
      .eq("user_id", user.id)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(PERFORMANCE.maxAttempts),
    supabase.from("quizzes").select("id, title, subject_id, mode").eq("user_id", user.id),
    supabase.from("subjects").select("id, name").eq("user_id", user.id),
    supabase
      .from("flashcard_reviews")
      .select("rating, reviewed_at")
      .eq("user_id", user.id)
      .order("reviewed_at", { ascending: false })
      .limit(PERFORMANCE.maxReviews),
    supabase.from("flashcard_reviews").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    // Only the topic labels of the uploaded past questions, for coverage.
    supabase.from("past_questions").select("topic").eq("user_id", user.id).not("topic", "is", null).limit(PERFORMANCE.maxAnswers),
  ]);

  const failed = [answers, questions, attempts, quizzes, subjects, reviews, reviewsTotal].find((result) => result.error);
  if (failed?.error) {
    console.error("[performance] load failed", { code: failed.error.code });
    throw new Error("Could not load performance.");
  }

  const questionById = new Map((questions.data as unknown as QuestionRow[]).map((question) => [question.id, question]));
  const input = {
    answers: (answers.data as AnswerRow[]).map((row) => {
      const question = questionById.get(row.question_id);
      return {
        questionId: row.question_id,
        quizId: row.quiz_id,
        result: row.result,
        answeredAt: row.answered_at,
        questionType: question?.question_type ?? null,
        difficulty: question?.difficulty ?? null,
        topic: question?.topic ?? null,
      };
    }),
    attempts: (attempts.data as AttemptRow[]).map((row) => ({
      id: row.id,
      quizId: row.quiz_id,
      // numeric columns arrive as strings or numbers depending on the client.
      score: Number(row.score ?? 0),
      total: row.total_questions,
      completedAt: row.completed_at,
    })),
    quizzes: (quizzes.data as { id: string; title: string; subject_id: string | null; mode: QuizRecord["mode"] }[]).map((quiz) => ({ id: quiz.id, title: quiz.title, subjectId: quiz.subject_id, mode: quiz.mode })),
    subjects: subjects.data as { id: string; name: string }[],
    reviews: (reviews.data as { rating: Rating; reviewed_at: string }[]).map((row) => ({ rating: row.rating, reviewedAt: row.reviewed_at })),
    reviewsTotal: reviewsTotal.count ?? 0,
    now: new Date(),
  };
  const performance = computePerformance(input);

  // Past questions arrived after the rest of this page. If their table cannot
  // be read (its migration not applied yet, say), readiness simply has no
  // topic coverage; nothing else here depends on it.
  if (pastTopics.error) console.error("[performance] past topics load failed", { code: pastTopics.error.code });
  const readiness = computeReadiness({
    answers: input.answers,
    attempts: input.attempts,
    quizzes: input.quizzes,
    performance,
    pastTopics: ((pastTopics.data ?? []) as { topic: string }[]).map((row) => row.topic),
    now: input.now,
  });

  // The wording of the few questions missed more than once.
  let repeatedQuestions: PerformanceReport["repeatedQuestions"] = [];
  if (performance.mistakes.repeated.length > 0) {
    const { data, error } = await supabase
      .from("quiz_questions")
      .select("id, question")
      .eq("user_id", user.id)
      .in("id", performance.mistakes.repeated.map((entry) => entry.questionId));
    if (error) {
      console.error("[performance] questions load failed", { code: error.code });
    } else {
      const wording = new Map((data as { id: string; question: string }[]).map((row) => [row.id, row.question]));
      repeatedQuestions = performance.mistakes.repeated
        .filter((entry) => wording.has(entry.questionId))
        .map((entry) => ({ ...entry, question: wording.get(entry.questionId)!, topic: questionById.get(entry.questionId)?.topic ?? null }));
    }
  }

  return { ...performance, repeatedQuestions, readiness };
}
