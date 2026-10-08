import { RETRIEVAL } from "../config";
import type { KnowledgeBaseQuery } from "../retrieval/query";
import type { RetrievedChunk } from "../retrieval/repository";
import { TUTOR } from "./config";
import { buildSystemPrompt } from "./prompt";
import type { ChatMessage } from "./provider";
import type { TutorMessage, TutorSource } from "./types";

// Everything that decides what the model is shown for one question: which
// passages, how much of the conversation, and in what shape. Pure functions,
// so each rule can be tested without a database or a model.

// A deterministic title from the first question: its first line, shortened
// at a word boundary.
export function titleFromMessage(message: string) {
  const firstLine = message.trim().split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  if (firstLine.length <= TUTOR.titleMaxLength) return firstLine;

  const cut = firstLine.slice(0, TUTOR.titleMaxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > TUTOR.titleMaxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// What to search the knowledge base for. A short follow-up such as "explain
// that more simply" names no topic, so it is searched together with the
// question before it.
export function buildSearchQuery(question: string, history: TutorMessage[]) {
  let text = question.trim();
  if (text.length < TUTOR.shortQuestionChars) {
    const previous = [...history].reverse().find((message) => message.role === "user");
    if (previous) text = `${previous.content.trim()}\n${text}`;
  }
  return text.replace(/\s+/g, " ").slice(0, RETRIEVAL.maxQueryLength);
}

// The search to run for a question. With a subject selected the threshold is
// lifted, so selectPassages can fall back to the closest passages when
// nothing is a strong match.
export function buildSearch(question: string, history: TutorMessage[], subjectId: string | null, topK: number): KnowledgeBaseQuery {
  const query: KnowledgeBaseQuery = { query: buildSearchQuery(question, history), topK, minScore: subjectId ? 0 : TUTOR.relevantScore };
  if (subjectId) query.subjectId = subjectId;
  return query;
}

// Chooses which search results the model sees. Results arrive most relevant
// first and that order is kept.
export function selectPassages(results: RetrievedChunk[], subjectSelected: boolean, topK: number) {
  let chosen = results.filter((chunk) => chunk.score >= TUTOR.relevantScore);
  if (chosen.length === 0 && subjectSelected) chosen = results.slice(0, TUTOR.fallbackPassages);

  const passages: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of chosen.slice(0, topK)) {
    if (passages.length > 0 && used + chunk.content.length > TUTOR.maxContextChars) break;
    passages.push(chunk);
    used += chunk.content.length;
  }
  return passages;
}

// The citation list for a set of passages. `n` matches the number the passage
// has in the prompt. Location details are copied as recorded, never guessed.
export function toSources(passages: RetrievedChunk[]): TutorSource[] {
  return passages.map((chunk, index) => ({
    n: index + 1,
    materialId: chunk.materialId,
    title: chunk.materialTitle,
    subject: chunk.subjectName,
    page: chunk.pageNumber,
    slide: chunk.slideNumber,
    section: chunk.sectionTitle,
  }));
}

function shorten(content: string) {
  if (content.length <= TUTOR.historyMessageMaxChars) return content;
  return `${content.slice(0, TUTOR.historyMessageMaxChars)}\n[…earlier message shortened]`;
}

// The part of the conversation the model is reminded of: the most recent
// messages that fit the budget, starting with one from the student.
//
// Older messages are simply left out. If conversations grow long enough for
// that to matter, a summary of the dropped part can be added here as an extra
// leading message without changing any caller.
export function selectHistory(history: TutorMessage[]): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0 && selected.length < TUTOR.historyMaxMessages; i--) {
    const content = shorten(history[i].content);
    if (used + content.length > TUTOR.historyMaxChars) break;
    selected.unshift({ role: history[i].role, content });
    used += content.length;
  }

  while (selected.length > 0 && selected[0].role !== "user") selected.shift();
  return selected;
}

export type TutorTurn = {
  // The student's latest message.
  question: string;
  // Earlier messages of the conversation, oldest first, without `question`.
  history: TutorMessage[];
  passages: RetrievedChunk[];
  subjectName: string | null;
  searched: boolean;
};

// The full request for the model: tutor instructions and study material,
// then the recent conversation, then the question.
export function buildModelMessages({ question, history, passages, subjectName, searched }: TutorTurn): ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt({ passages, subjectName, searched }) },
    ...selectHistory(history),
    { role: "user", content: question },
  ];
}
