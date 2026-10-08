import type { Metadata } from "next";
import { TutorView } from "@/components/tutor/tutor-view";
import { isTutorConfigured } from "@/lib/ai/tutor/provider";
import { getExplainRequest } from "@/lib/ai/practice/queries";
import { getConversations, getConversationWithMessages } from "@/lib/ai/tutor/queries";
import { getSubjects } from "@/lib/library/queries";
import { getExamQuestionExplainRequest, getPastQuestionExplainRequest } from "@/lib/past-questions/queries";

export const metadata: Metadata = { title: "AI Tutor — Ari" };

// /tutor              a new chat
// /tutor?c=<id>       an existing conversation
// /tutor?subject=<id> a new chat about one subject
// /tutor?explain=<id> a new chat that opens by asking Ari to explain one of
//                     the student's own quiz answers
// /tutor?explainPast=<id>      the same for one of their uploaded past questions
// /tutor?explainQuestion=<id>  the same for a question left unanswered in a
//                              finished exam
type Param = string | string[] | undefined;
type Props = { searchParams: Promise<{ c?: Param; subject?: Param; explain?: Param; explainPast?: Param; explainQuestion?: Param }> };

export default async function TutorPage({ searchParams }: Props) {
  const params = await searchParams;
  const conversationId = typeof params.c === "string" ? params.c : null;
  const param = (value: Param) => (!conversationId && typeof value === "string" ? value : null);
  const explainId = param(params.explain);
  const explainPastId = param(params.explainPast);
  const explainQuestionId = param(params.explainQuestion);

  // A failure to load the list or the subjects degrades the page instead of
  // replacing the chat with the error screen.
  const [subjects, conversations, opened, explain] = await Promise.all([
    getSubjects().catch(() => []),
    getConversations().catch(() => null),
    // Null for an unknown id, a malformed id, and another user's conversation alike.
    conversationId ? getConversationWithMessages(conversationId).catch(() => null) : null,
    // Null for an unknown answer and for another user's answer alike. The
    // same holds for a past question and for an exam question.
    explainId
      ? getExplainRequest(explainId).catch(() => null)
      : explainPastId
        ? getPastQuestionExplainRequest(explainPastId).catch(() => null)
        : explainQuestionId
          ? getExamQuestionExplainRequest(explainQuestionId).catch(() => null)
          : null,
  ]);
  // The quiz's subject, so Ari searches the material the question came from.
  const subjectParam = explain ? explain.subjectId : typeof params.subject === "string" ? params.subject : null;

  return (
    <TutorView
      autoAsk={explain?.message ?? null}
      conversation={opened?.conversation ?? null}
      conversations={conversations ?? []}
      initialSubjectId={subjects.some((subject) => subject.id === subjectParam) ? subjectParam : null}
      // A different conversation is a different chat: start it with fresh state.
      key={opened?.conversation.id ?? (explain ? `explain-${explainId ?? explainPastId ?? explainQuestionId}` : "new")}
      listFailed={!conversations}
      messages={opened?.messages ?? []}
      missing={Boolean(conversationId) && !opened}
      subjects={subjects.map(({ id, name, color, icon }) => ({ id, name, color, icon }))}
      tutorEnabled={isTutorConfigured()}
    />
  );
}
