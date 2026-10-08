import type { Metadata } from "next";
import { QuizzesView } from "@/components/practice/quizzes-view";
import { getPracticeOptions, getQuizList } from "@/lib/ai/practice/queries";
import { isTutorConfigured } from "@/lib/ai/tutor/provider";

export const metadata: Metadata = { title: "Quizzes — Ari" };

// Creating a quiz calls the chat model from a Server Action on this page.
// This is how long the platform should let that run.
export const maxDuration = 300;

export default async function QuizzesPage() {
  // A failure to load the history degrades the page instead of replacing it
  // with the error screen.
  const [{ subjects, materials }, quizzes] = await Promise.all([getPracticeOptions(), getQuizList().catch(() => null)]);

  return (
    <div className="dashboard library-page">
      <QuizzesView enabled={isTutorConfigured()} listFailed={!quizzes} materials={materials} quizzes={quizzes ?? []} subjects={subjects} />
    </div>
  );
}
