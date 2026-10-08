import mammoth from "mammoth";
import { ProcessingError } from "../errors";
import type { Block, ExtractedDocument } from "./types";
import { decodeEntities, readZipEntries } from "./zip";

// Private markers placed in the text while tags are stripped, so headings and
// table rows can be recognised afterwards.
const HEADING = "\u0001";
const TABLE_ROW = "\u0002";
const TABLE_END = "\u0003";

// Turns Mammoth's HTML into ordered blocks. Mammoth emits a small, predictable
// set of tags, so this works by replacing the structural ones with line breaks
// and markers, then dropping the rest. Nesting (lists in lists, tables in
// cells) cannot confuse it because nothing is matched as a pair.
export function htmlToBlocks(html: string): Block[] {
  const text = html
    // Keep each table cell on one line: paragraphs inside a cell become spaces.
    .replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_cell, inner: string) => `${inner.replace(/<\/?(p|li|br)\b[^>]*>/gi, " ")}</td>`)
    .replace(/<h[1-6]\b[^>]*>/gi, `\n${HEADING}`)
    .replace(/<tr\b[^>]*>/gi, `\n${TABLE_ROW}`)
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/table>/gi, `\n${TABLE_END}\n`)
    .replace(/<\/(p|h[1-6]|li|tr|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const blocks: Block[] = [];
  let tableRows: string[] = [];
  const flushTable = () => {
    if (tableRows.length > 0) blocks.push({ kind: "table", text: tableRows.join("\n") });
    tableRows = [];
  };

  for (const rawLine of decodeEntities(text).split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    // Blank lines separate rows as well as paragraphs, so they end nothing.
    if (!line) continue;
    if (line === TABLE_END) {
      flushTable();
      continue;
    }
    if (line.startsWith(TABLE_ROW)) {
      const row = line.slice(1).replace(/(\s*\|\s*)+$/, "").trim();
      if (row) tableRows.push(row);
      continue;
    }

    flushTable();
    if (line === "•") continue;
    if (line.startsWith(HEADING)) {
      const heading = line.slice(1).trim();
      if (heading) blocks.push({ kind: "heading", text: heading });
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
  }
  flushTable();
  return blocks;
}

// Extracts headings, paragraphs, lists and tables from a Word document.
// Images are skipped and macros are never run: only document text is read.
export async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  // Checks the archive's expanded size before Mammoth decompresses it.
  readZipEntries(bytes, () => false);

  try {
    const { value: html } = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
    );
    return { units: [{ blocks: htmlToBlocks(html) }] };
  } catch (error) {
    throw new ProcessingError("EXTRACTION_FAILED", `docx: ${(error as Error).message}`);
  }
}
