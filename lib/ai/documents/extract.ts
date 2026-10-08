import { ProcessingError } from "../errors";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractPpt } from "./ppt";
import { extractPptx } from "./pptx";
import { extractTxt } from "./text";
import type { ExtractedDocument, ExtractionInput } from "./types";

const IMAGE_TYPES = new Set(["png", "jpg", "webp"]);

// Picks the extractor for a file. Extractors only read content: nothing in an
// uploaded file is ever executed, and whatever a document says is treated as
// text to be stored, never as an instruction.
export async function extractDocument({ bytes, typeId }: ExtractionInput): Promise<ExtractedDocument> {
  if (bytes.byteLength === 0) throw new ProcessingError("EMPTY_DOCUMENT", "file has no bytes");

  switch (typeId) {
    case "pdf":
      return extractPdf(bytes);
    case "docx":
      return extractDocx(bytes);
    case "pptx":
      return extractPptx(bytes);
    case "ppt":
      return extractPpt(bytes);
    case "txt":
      return extractTxt(bytes);
    default:
      // An image has no text layer at all, so it always goes to OCR.
      if (IMAGE_TYPES.has(typeId)) return { units: [], needsOcr: true };
      throw new ProcessingError("UNSUPPORTED_FILE", `no extractor for "${typeId}"`);
  }
}
