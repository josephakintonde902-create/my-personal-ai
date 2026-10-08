import { RETRIEVAL } from "../config";
import type { KnowledgeBaseQuery } from "../retrieval/query";
import type { RetrievedChunk } from "../retrieval/repository";
import { describeLocation } from "../tutor/citations";
import { toSources } from "../tutor/context";
import { PRACTICE } from "./config";
import type { PracticeSource } from "./types";

// Chooses the study material a quiz or deck is written from. Everything
// comes from the existing knowledge base search (searchKnowledgeBase), which
// only ever returns the signed-in student's own passages. PDFs, PowerPoint
// slides, Word documents and text files are all just passages here, each
// carrying the page, slide or section it came from.

export type PracticeScope = {
  subject: { id: string; name: string } | null;
  material: { id: string; title: string } | null;
  // What the student asked to focus on, if anything.
  topic: string;
};

// The search to run. With a topic, the closest passages to it. Without one,
// a wide sample of the material in scope, from which selectPassages picks an
// even spread.
export function buildPracticeSearch({ subject, material, topic }: PracticeScope, limit: number): KnowledgeBaseQuery {
  const about = material?.title ?? subject?.name ?? "study notes";
  const query: KnowledgeBaseQuery = {
    query: (topic || `${about}: key concepts, definitions, mechanisms and important facts`).slice(0, RETRIEVAL.maxQueryLength),
    topK: topic ? limit : PRACTICE.searchPoolSize,
    // Scope, not similarity, decides what is eligible: the student chose it.
    minScore: 0,
  };
  if (subject) query.subjectId = subject.id;
  if (material) query.materialId = material.id;
  return query;
}

// Picks the passages to write from. A focused request keeps the best
// matches. An open one spreads across the material in reading order, so a
// quiz on a lecture covers the whole lecture and not just one part of it.
export function selectPassages(results: RetrievedChunk[], limit: number, focused: boolean) {
  const usable = results.filter((chunk) => chunk.content.trim().length >= 40);
  if (focused || usable.length <= limit) return usable.slice(0, limit);

  const ordered = [...usable].sort((a, b) => a.materialId.localeCompare(b.materialId) || a.chunkIndex - b.chunkIndex);
  return Array.from({ length: limit }, (_, i) => ordered[Math.floor((i * ordered.length) / limit)]);
}

// "[3] "Cardiovascular Physiology — Lecture 4" — subject: Physiology — slide 18"
export function describePassages(passages: RetrievedChunk[]) {
  return passages
    .map((chunk, index) => {
      const location = describeLocation({ page: chunk.pageNumber, slide: chunk.slideNumber, section: chunk.sectionTitle });
      const header = [`[${index + 1}] "${chunk.materialTitle}"`, `subject: ${chunk.subjectName}`, location].filter(Boolean).join(" — ");
      return `${header}\n"""\n${chunk.content.trim().slice(0, PRACTICE.maxPassageChars)}\n"""`;
    })
    .join("\n\n");
}

// The source details of each passage, by its number. Copied from the
// knowledge base, never taken from the model.
export function passageSources(passages: RetrievedChunk[]): Map<number, { source: PracticeSource; excerpt: string }> {
  const sources = toSources(passages);
  return new Map(
    sources.map((source, index) => [source.n, { source, excerpt: passages[index].content.trim().slice(0, PRACTICE.sourceExcerptChars) }]),
  );
}
