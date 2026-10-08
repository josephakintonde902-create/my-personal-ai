import mammoth from "mammoth";
import { cleanDocument } from "@/lib/ai/documents/clean";
import { htmlToBlocks } from "@/lib/ai/documents/docx";
import { extractDocument } from "@/lib/ai/documents/extract";
import type { ExtractedDocument } from "@/lib/ai/documents/types";
import { readZipEntries } from "@/lib/ai/documents/zip";
import { ProcessingError, toProcessingError } from "@/lib/ai/errors";

// Reads an uploaded paper into text, with the same extractors study
// materials use. One thing differs. Word numbers lists automatically, and
// those numbers are not part of the document's text, so a paper typed as a
// numbered list would arrive with every "1." and "A." missing. Here they are
// put back before the text is read.

const LIST_TAG = /<(\/?)(ol|ul|li)\b[^>]*>/gi;

// Writes each ordered list item's number into its text: "1." for a question,
// "A." for a list nested inside one. Numbering carries on from one top-level
// list to the next, as it does on the page when options sit between them.
export function numberListItems(html: string) {
  const open: { ordered: boolean; count: number }[] = [];
  let topCount = 0;
  let numbered = false;

  const result = html.replace(LIST_TAG, (tag, closing: string, name: string) => {
    const kind = name.toLowerCase();
    if (kind === "li") {
      const list = open[open.length - 1];
      if (closing || !list?.ordered) return tag;
      list.count++;
      const depth = open.filter((item) => item.ordered).length;
      if (depth > 1 && list.count > 26) return tag;
      numbered = true;
      return `${tag}${depth === 1 ? `${list.count}.` : `${String.fromCharCode(64 + list.count)}.`} `;
    }
    if (!closing) {
      open.push({ ordered: kind === "ol", count: kind === "ol" && open.length === 0 ? topCount : 0 });
      return tag;
    }
    const closed = open.pop();
    if (closed?.ordered && open.length === 0) topCount = closed.count;
    return tag;
  });
  return { html: result, numbered };
}

export type ReadPaper = {
  document: ExtractedDocument;
  // False when numbers were put back by numberListItems rather than read.
  numbersPrinted: boolean;
};

export async function readPaper(input: { bytes: Uint8Array; typeId: string; mimeType: string }): Promise<ReadPaper> {
  let document: ExtractedDocument;
  let numbersPrinted = true;

  try {
    if (input.typeId === "docx") {
      if (input.bytes.byteLength === 0) throw new ProcessingError("EMPTY_DOCUMENT", "file has no bytes");
      // Checks the archive's expanded size before Mammoth decompresses it.
      readZipEntries(input.bytes, () => false);
      const { value } = await mammoth.convertToHtml(
        { buffer: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength) },
        { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
      );
      const { html, numbered } = numberListItems(value);
      numbersPrinted = !numbered;
      document = { units: [{ blocks: htmlToBlocks(html) }] };
    } else {
      document = await extractDocument(input);
    }
  } catch (error) {
    throw toProcessingError(error, "EXTRACTION_FAILED");
  }

  // Scanned pages have no text to read, and Ari has no OCR provider. Said
  // plainly rather than passing off an empty paper as processed.
  if (document.needsOcr) throw new ProcessingError("OCR_UNAVAILABLE", `no text layer in ${input.typeId}`);
  return { document: cleanDocument(document), numbersPrinted };
}
