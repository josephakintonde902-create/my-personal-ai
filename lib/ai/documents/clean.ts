import type { DocumentUnit, ExtractedDocument } from "./types";

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

// Characters that carry no content: NUL and other control codes (tab and
// newline are kept), soft hyphens, zero-width characters, byte-order marks,
// and the replacement character left behind by bad decoding.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200D\u2060\uFEFF\uFFFD]/g;
// Non-breaking and other typographic spaces.
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

// Tidies extraction artifacts without changing what the text says: the words,
// their order, punctuation, and symbols are left exactly as written.
export function normalizeText(text: string) {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\uFB00-\uFB06]/g, (ligature) => LIGATURES[ligature] ?? ligature)
    .replace(INVISIBLE, "")
    .replace(ODD_SPACES, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A line with its digits removed, so "Page 3 of 20" and "Page 4 of 20" match.
function lineSignature(line: string) {
  return line.replace(/\d+/g, "#").trim().toLowerCase();
}

function edgeLines(unit: DocumentUnit) {
  const lines = unit.blocks.flatMap((block) => block.text.split("\n")).filter((line) => line.trim());
  return { first: lines[0], last: lines.length > 1 ? lines[lines.length - 1] : undefined };
}

// Running headers and footers ("Chapter 2 — Cells", "Page 7") repeat on every
// page and would otherwise be scattered through the chunks. A line is treated
// as one only when it is the first or last line of most pages, so body text
// is never removed.
function findRepeatedEdgeLines(units: DocumentUnit[]) {
  const MIN_PAGES = 4;
  if (units.length < MIN_PAGES) return new Set<string>();

  const counts = new Map<string, number>();
  for (const unit of units) {
    const { first, last } = edgeLines(unit);
    for (const line of new Set([first, last])) {
      if (!line || line.length > 120) continue;
      const signature = lineSignature(line);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
  }

  const threshold = Math.ceil(units.length * 0.6);
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([signature]) => signature));
}

function stripEdgeLines(unit: DocumentUnit, repeated: Set<string>): DocumentUnit {
  if (repeated.size === 0) return unit;

  const blocks = unit.blocks.map((block) => ({ ...block }));
  const strip = (fromStart: boolean) => {
    const block = fromStart ? blocks.find((b) => b.text.trim()) : [...blocks].reverse().find((b) => b.text.trim());
    if (!block) return;
    const lines = block.text.split("\n");
    const index = fromStart ? lines.findIndex((l) => l.trim()) : lines.findLastIndex((l) => l.trim());
    if (index >= 0 && repeated.has(lineSignature(lines[index]))) {
      lines.splice(index, 1);
      block.text = lines.join("\n");
    }
  };
  strip(true);
  strip(false);
  return { ...unit, blocks };
}

// Normalizes every block and drops the ones left empty.
export function cleanDocument(document: ExtractedDocument): ExtractedDocument {
  const normalized = document.units.map((unit) => ({
    ...unit,
    title: unit.title ? normalizeText(unit.title) || undefined : undefined,
    blocks: unit.blocks.map((block) => ({ ...block, text: normalizeText(block.text) })),
  }));

  const paged = normalized.every((unit) => unit.pageNumber !== undefined);
  const repeated = paged ? findRepeatedEdgeLines(normalized) : new Set<string>();

  const units = normalized
    .map((unit) => stripEdgeLines(unit, repeated))
    .map((unit) => ({
      ...unit,
      blocks: unit.blocks.map((block) => ({ ...block, text: block.text.trim() })).filter((block) => block.text),
    }))
    .filter((unit) => unit.blocks.length > 0);

  return { ...document, units };
}

export function countWords(document: ExtractedDocument) {
  let words = 0;
  for (const unit of document.units) {
    for (const block of unit.blocks) words += block.text.split(/\s+/).filter(Boolean).length;
  }
  return words;
}

export function countCharacters(document: ExtractedDocument) {
  let characters = 0;
  for (const unit of document.units) {
    for (const block of unit.blocks) characters += block.text.length;
  }
  return characters;
}
