import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExamReview } from "@/components/exam/exam-review";
import { ExamRunner } from "@/components/exam/exam-runner";
import { getExamPage } from "@/lib/past-questions/queries";

export const metadata: Metadata = { title: "Exam — Ari" };

type Props = { params: Promise<{ id: string }> };

// One exam attempt. While it is open this renders the exam itself, with
// questions only; once submitted, the same address shows the marked review.
export default async function ExamAttemptPage({ params }: Props) {
  const { id } = await params;

  // Null for an unknown id, a malformed id, and another user's exam alike.
  const page = await getExamPage(id);
  if (!page) notFound();

  return (
    <div className="dashboard library-page">
      {page.status === "open" ? (
        <ExamRunner
          attemptId={page.attempt.id}
          initialState={page.state}
          // A new attempt is a new exam: start it with fresh state.
          key={page.attempt.id}
          questions={page.questions}
          remainingSeconds={page.remainingSeconds}
          title={page.quiz.title.replace(/^Exam: /, "")}
        />
      ) : (
        <ExamReview review={page.review} subjectName={page.subjectName} />
      )}
    </div>
  );
}
