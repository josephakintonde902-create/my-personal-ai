import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { QuizRunner } from "@/components/practice/quiz-runner";
import { getQuizPage } from "@/lib/ai/practice/queries";
import { getSubject } from "@/lib/library/queries";

export const metadata: Metadata = { title: "Quiz — Ari" };

// Short answers are marked by the chat model from a Server Action here.
export const maxDuration = 120;

type Props = { params: Promise<{ id: string }> };

export default async function QuizPage({ params }: Props) {
  const { id } = await params;

  // Null for an unknown id, a malformed id, and another user's quiz alike.
  const page = await getQuizPage(id);
  if (!page) notFound();

  const subject = page.quiz.subjectId ? await getSubject(page.quiz.subjectId).catch(() => null) : null;

  return (
    <div className="dashboard library-page">
      <QuizRunner
        attempt={page.attempt}
        feedback={page.feedback}
        questions={page.questions}
        quiz={page.quiz}
        subjectName={subject?.name ?? null}
        summary={page.summary}
      />
    </div>
  );
}
