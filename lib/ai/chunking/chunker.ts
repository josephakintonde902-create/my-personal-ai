import { CHARS_PER_TOKEN, CHUNKING, estimateTokens } from "../config";
import type { BlockKind, ExtractedDocument } from "../documents/types";

export type ChunkingConfig = typeof CHUNKING;

export type Chunk = {
  index: number;
  content: string;
  // Where the chunk starts in the source. A chunk can run on to the next page.
  pageNumber?: number;
  slideNumber?: number;
  // The nearest heading (or slide title) above the start of the chunk.
  sectionTitle?: string;
  tokenCount: number;
};

type Piece = {
  text: string;
  kind: BlockKind;
  pageNumber?: number;
  slideNumber?: number;
  sectionTitle?: string;
};

// Breaks text that is too long for one chunk, preferring the end of a
// sentence or line, then a space, and only as a last resort mid-word.
export function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.length > maxChars) {
      push();
      let rest = sentence;
      while (rest.length > maxChars) {
        const space = rest.lastIndexOf(" ", maxChars);
        const cut = space > maxChars / 2 ? space : maxChars;
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current && current.length + 1 + sentence.length > maxChars) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return parts;
}

// The end of a chunk, repeated at the start of the next. Starts at a sentence
// or word boundary so the overlap never begins mid-word.
function overlapTail(content: string, overlapChars: number) {
  if (overlapChars <= 0 || content.length <= overlapChars) return "";

  const tail = content.slice(-overlapChars);
  const sentenceStart = tail.search(/(?<=[.!?])\s+\S|\n\S/);
  if (sentenceStart >= 0 && sentenceStart < tail.length / 2) {
    return tail.slice(sentenceStart).trim();
  }
  const space = tail.indexOf(" ");
  return space >= 0 ? tail.slice(space + 1).trim() : tail;
}

function toPieces(document: ExtractedDocument, maxPieceChars: number): Piece[] {
  const pieces: Piece[] = [];
  let sectionTitle: string | undefined;

  for (const unit of document.units) {
    // Each slide is its own section; pages carry the last heading forward.
    if (unit.slideNumber !== undefined) sectionTitle = unit.title;

    for (const block of unit.blocks) {
      if (block.kind === "heading") sectionTitle = block.text;
      for (const text of splitLongText(block.text, maxPieceChars)) {
        pieces.push({
          text,
          kind: block.kind,
          pageNumber: unit.pageNumber,
          slideNumber: unit.slideNumber,
          sectionTitle,
        });
      }
    }
  }
  return pieces;
}

// Groups a document's blocks into chunks of roughly `targetTokens`.
//
// Boundaries fall between blocks wherever possible: a heading starts a new
// chunk once the current one has some substance, and paragraphs are kept
// whole. Only a single block longer than a chunk is split, at sentence ends.
// Consecutive chunks share `overlapTokens` of text, except across a heading,
// where the new section starts clean.
export function chunkDocument(document: ExtractedDocument, config: ChunkingConfig = CHUNKING): Chunk[] {
  const targetChars = config.targetTokens * CHARS_PER_TOKEN;
  const overlapChars = config.overlapTokens * CHARS_PER_TOKEN;
  const headingBreakChars = config.headingBreakTokens * CHARS_PER_TOKEN;
  // Leaves room for the overlap, so a chunk never exceeds maxTokens.
  const maxPieceChars = Math.min(targetChars, config.maxTokens * CHARS_PER_TOKEN - overlapChars);

  const chunks: Chunk[] = [];
  let overlap = "";
  let parts: string[] = [];
  let length = 0;
  let start: Piece | undefined;

  const flush = (carryOverlap: boolean) => {
    if (!start) return;
    const content = [overlap, ...parts].filter(Boolean).join("\n\n");
    chunks.push({
      index: chunks.length,
      content,
      pageNumber: start.pageNumber,
      slideNumber: start.slideNumber,
      sectionTitle: start.sectionTitle,
      tokenCount: estimateTokens(content),
    });
    overlap = carryOverlap ? overlapTail(parts.join("\n\n"), overlapChars) : "";
    parts = [];
    length = 0;
    start = undefined;
  };

  for (const piece of toPieces(document, maxPieceChars)) {
    if (start) {
      if (piece.kind === "heading" && length >= headingBreakChars) flush(false);
      else if (overlap.length + length + piece.text.length > targetChars) flush(true);
    }
    start ??= piece;
    parts.push(piece.text);
    length += piece.text.length + 2;
  }
  flush(false);

  return chunks;
}

// The text that is embedded for a chunk. The section title is added when the
// chunk does not already begin with it, so a passage from the middle of a
// section is still matched by questions that mention the section's topic.
export function embeddingInput(chunk: Pick<Chunk, "content" | "sectionTitle">) {
  if (!chunk.sectionTitle || chunk.content.startsWith(chunk.sectionTitle)) return chunk.content;
  return `${chunk.sectionTitle}\n\n${chunk.content}`;
}
