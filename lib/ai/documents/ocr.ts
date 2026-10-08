import type { ExtractedDocument } from "./types";

// Reads text out of images and scanned PDFs.
//
// No provider ships with Ari yet. Running OCR means either sending students'
// private files to an external service or adding a heavy local engine, and
// neither should happen without a deliberate choice of provider. Until one is
// configured, files that need OCR fail with OCR_UNAVAILABLE and a clear
// message; they are never marked ready with empty or invented text.
//
// To add one: implement this interface (for example with a vision model or a
// cloud OCR API), return it from getOcrProvider() when its environment
// variables are present, and it will be used automatically by the pipeline.
export interface OcrProvider {
  readonly name: string;
  // Returns one unit per page (or a single unit for an image), with
  // pageNumber set for PDFs so page references keep working.
  recognize(input: { bytes: Uint8Array; mimeType: string }): Promise<ExtractedDocument>;
}

export function getOcrProvider(): OcrProvider | null {
  return null;
}
