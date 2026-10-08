import { extractText, getDocumentProxy } from "unpdf";
import { PROCESSING } from "../config";
import { ProcessingError } from "../errors";
import { splitParagraphs } from "./text";
import type { ExtractedDocument } from "./types";

// Extracts the text layer of each page, keeping page numbers so answers can
// later point to where something was said. Only text is read: scripts, forms
// and attachments inside the PDF are never executed or opened.
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  let pages: string[];
  try {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text;
  } catch (error) {
    throw new ProcessingError("EXTRACTION_FAILED", `pdf: ${(error as Error).message}`);
  }

  const units = pages.map((text, index) => ({
    pageNumber: index + 1,
    blocks: splitParagraphs(text).map((paragraph) => ({ kind: "paragraph" as const, text: paragraph })),
  }));

  // A scanned PDF is a stack of page images. Its pages have no text layer, or
  // only a stray page number. Pages are judged one by one rather than by an
  // average, so a deck with a few words per slide is not mistaken for a scan.
  const textless = pages.filter((text) => text.replace(/\s+/g, "").length < PROCESSING.textlessPageChars).length;
  const needsOcr = pages.length > 0 && textless / pages.length > PROCESSING.scannedPageShare;

  return { units, pageCount: pages.length, needsOcr };
}
