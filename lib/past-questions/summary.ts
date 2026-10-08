import type { Difficulty } from "@/lib/ai/practice/types";
import { UNCATEGORIZED, type PastSelection } from "./config";
import type { PastQuestionSummary } from "./types";

// Counting over question summaries, for the forms that set up practice and
// exams. This only decides what a form shows ("23 questions match"); the
// questions themselves are always chosen again on the server
// (selectQuestions in sessions.ts), from the database, when a session starts.

export type SummaryFilter = {
  kind: "practice" | "exam";
  // Null means every collection.
  setIds: Set<string> | null;
  year: number | null;
  topic: string | null;
  difficulty: Difficulty | null;
  selection: PastSelection;
};

const normalize = (topic: string | null) => (topic ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function topicLabel(topic: string | null) {
  return topic || UNCATEGORIZED;
}

export function matchingSummaries(summaries: PastQuestionSummary[], filter: SummaryFilter) {
  return summaries.filter((question) => {
    if (!question.answerable) return false;
    if (filter.kind === "exam" && question.type !== "multiple_choice" && question.type !== "true_false") return false;
    if (filter.setIds && !filter.setIds.has(question.setId)) return false;
    if (filter.year !== null && question.year !== filter.year) return false;
    if (filter.topic !== null && normalize(topicLabel(question.topic)) !== normalize(filter.topic)) return false;
    if (filter.difficulty !== null && question.difficulty !== filter.difficulty) return false;
    if (filter.selection === "unanswered" && question.lastResult !== null) return false;
    if (filter.selection === "missed" && (question.lastResult === null || question.lastResult === "correct")) return false;
    return true;
  });
}

// The years and topics present in a set of summaries, for filter menus.
export function summaryFacets(summaries: PastQuestionSummary[]) {
  const years = [...new Set(summaries.map((question) => question.year).filter((year): year is number => year !== null))].sort((a, b) => b - a);
  const topics = new Map<string, string>();
  for (const question of summaries) {
    if (question.type === "raw") continue;
    const label = topicLabel(question.topic);
    if (!topics.has(normalize(label))) topics.set(normalize(label), label);
  }
  return { years, topics: [...topics.values()].sort((a, b) => (a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b))) };
}
