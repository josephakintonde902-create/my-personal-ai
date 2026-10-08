"use server";

import { toResult, type PracticeResult } from "@/lib/ai/practice/errors";
import { practiceDeps } from "@/lib/ai/practice/queries";
import { answerQuestion, completeAttempt, generateQuiz, startAttempt, type AnswerInput } from "@/lib/ai/practice/quiz-service";
import type { AnswerFeedback, GenerateQuizInput, PublicQuestion, QuizAttempt, QuizSummary } from "@/lib/ai/practice/types";
import { getCurrentUser } from "@/lib/auth/dal";
import { isUuid } from "@/lib/library/files";
import type { ActionResult } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";

// Thin wrappers: each action hands the request to lib/ai/practice with the
// real session, database, search and model. The student is always the
// session's user; nothing here accepts a user id. The model is called on the
// server, so its API key never reaches the browser.

export async function generateQuizAction(input: GenerateQuizInput): Promise<PracticeResult<{ quizId: string; delivered: number; requested: number }>> {
  return toResult("quiz generation", async () => {
    const { quiz, requested } = await generateQuiz(input, practiceDeps());
    return { quizId: quiz.id, delivered: quiz.questionCount, requested };
  });
}

export async function startAttemptAction(quizId: string): Promise<PracticeResult<{ attempt: QuizAttempt; questions: PublicQuestion[] }>> {
  return toResult("quiz start", () => startAttempt(quizId, practiceDeps()));
}

export async function answerQuestionAction(input: AnswerInput): Promise<PracticeResult<AnswerFeedback>> {
  return toResult("quiz answer", () => answerQuestion(input, practiceDeps()));
}

export async function completeAttemptAction(attemptId: string): Promise<PracticeResult<QuizSummary & { review: AnswerFeedback[] }>> {
  return toResult("quiz completion", () => completeAttempt(attemptId, practiceDeps()));
}

// Deletes one of the signed-in user's quizzes. Its questions, attempts and
// answers are removed with it by the database (on delete cascade). Deleting
// a quiz that is already gone, or that belongs to someone else, changes
// nothing and is reported as done.
export async function deleteQuizAction(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  if (!isUuid(id)) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase.from("quizzes").delete().eq("user_id", user.id).eq("id", id);
  if (error) {
    console.error("[practice] quiz delete failed", { code: error.code });
    return { ok: false, error: "We couldn't delete this quiz. Please try again." };
  }
  return { ok: true };
}
