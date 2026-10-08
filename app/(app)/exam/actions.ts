"use server";

import { revalidatePath } from "next/cache";
import { toResult, type PracticeResult } from "@/lib/ai/practice/errors";
import { pastDeps } from "@/lib/past-questions/queries";
import { createPastSession, saveExamProgress, submitExam, type ExamInput, type PastSessionInput } from "@/lib/past-questions/sessions";

// Thin wrappers around lib/past-questions/sessions. The student is always
// the session's user. An exam's answers are marked on the server: these
// actions accept the student's choices and nothing else, and return no
// correct answer until the exam has been submitted.

export async function startExamAction(input: Omit<PastSessionInput, "kind" | "selection" | "retryAttemptId">): Promise<PracticeResult<{ attemptId: string; questions: number }>> {
  return toResult("exam start", async () => {
    const { attempt, delivered } = await createPastSession({ ...input, kind: "exam", selection: undefined, retryAttemptId: undefined }, pastDeps());
    revalidatePath("/exam");
    return { attemptId: attempt!.id, questions: delivered };
  });
}

export async function saveExamProgressAction(input: ExamInput): Promise<PracticeResult<{ saved: boolean }>> {
  return toResult("exam save", () => saveExamProgress(input, pastDeps()));
}

// Returns only the headline figures. The page then reloads and shows the
// full review, read from what the database stored.
export async function submitExamAction(input: ExamInput): Promise<PracticeResult<{ percent: number; correct: number; total: number }>> {
  return toResult("exam submission", async () => {
    const review = await submitExam(input, pastDeps());
    revalidatePath("/exam", "layout");
    revalidatePath("/performance");
    revalidatePath("/dashboard");
    return { percent: review.totals.percent, correct: review.totals.correct, total: review.totals.total };
  });
}
