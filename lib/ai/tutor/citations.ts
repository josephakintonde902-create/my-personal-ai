import type { TutorSource } from "./types";

// Ari cites a passage by its number in square brackets: "[2]" or "[1, 3]".
// These helpers find those markers so the UI can show which of the student's
// materials an answer actually drew on, and nothing it did not use.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
const MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g;

// "page 12 · Refraction", using only the details the knowledge base recorded.
export function describeLocation(source: Pick<TutorSource, "page" | "slide" | "section">) {
  const parts: string[] = [];
  if (source.page !== null) parts.push(`page ${source.page}`);
  if (source.slide !== null) parts.push(`slide ${source.slide}`);
  if (source.section) parts.push(source.section);
  return parts.join(" · ");
}

// "Anatomy Lecture 3 — page 12 · Cornea". Only details the knowledge base
// recorded are shown; a passage with no page or slide gets just its title.
export function sourceLabel(source: TutorSource) {
  const location = describeLocation(source);
  return location ? `${source.title} — ${location}` : source.title;
}

function parseMarker(numbers: string, known: Set<number>) {
  const parsed = numbers.split(",").map((part) => Number.parseInt(part, 10));
  // "[5]" with no fifth source is ordinary text (a list index, a footnote in
  // the student's own writing), not a citation.
  return parsed.every((n) => known.has(n)) ? parsed : null;
}

function mapProse(content: string, transform: (prose: string) => string) {
  // Odd-numbered pieces are code, which is left exactly as written.
  return content.split(CODE).map((piece, index) => (index % 2 === 1 ? piece : transform(piece))).join("");
}

// The sources an answer cites, in the order they are numbered. Sources that
// were offered to the model but not cited are left out.
export function citedSources(content: string, sources: TutorSource[]) {
  const known = new Set(sources.map((source) => source.n));
  const cited = new Set<number>();
  mapProse(content, (prose) => {
    for (const match of prose.matchAll(MARKER)) parseMarker(match[1], known)?.forEach((n) => cited.add(n));
    return prose;
  });
  return sources.filter((source) => cited.has(source.n));
}

export const SOURCE_LINK_PREFIX = "#source-";

// Rewrites citation markers as Markdown links ("[2](#source-2)") so the
// renderer can display them as small reference numbers.
export function linkCitations(content: string, sources: TutorSource[]) {
  if (sources.length === 0) return content;
  const known = new Set(sources.map((source) => source.n));

  return mapProse(content, (prose) =>
    prose.replace(MARKER, (marker, numbers: string) => {
      const parsed = parseMarker(numbers, known);
      return parsed ? parsed.map((n) => `[${n}](${SOURCE_LINK_PREFIX}${n})`).join("") : marker;
    }),
  );
}
