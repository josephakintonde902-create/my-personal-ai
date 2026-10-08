// Every way processing can fail, with the message the student sees. The
// message is stored in study_materials.processing_error, so it must never
// contain stack traces, provider responses, or secrets.
export const PROCESSING_ERROR_MESSAGES = {
  UNSUPPORTED_FILE: "This file type can't be processed.",
  EXTRACTION_FAILED: "We couldn't read this file. It may be damaged or password-protected.",
  OCR_UNAVAILABLE:
    "This file contains scanned pages or images rather than text. Reading those isn't available yet.",
  OCR_FAILED: "We couldn't read the text in this image or scan.",
  EMPTY_DOCUMENT: "No readable text could be extracted from this document.",
  DOCUMENT_TOO_LARGE: "This document is too long to process. Try splitting it into smaller files.",
  DOWNLOAD_FAILED: "We couldn't open the uploaded file. Please try again.",
  EMBEDDING_NOT_CONFIGURED: "Ari's knowledge base isn't set up yet.",
  EMBEDDING_FAILED: "We couldn't prepare this material for Ari. Please try again in a moment.",
  VECTOR_STORAGE_FAILED: "We couldn't save this material to your knowledge base. Please try again.",
  PROCESSING_TIMEOUT: "This material took too long to process. Please try again.",
  UNKNOWN: "Something went wrong while processing this material. Please try again.",
} as const;

export type ProcessingErrorCode = keyof typeof PROCESSING_ERROR_MESSAGES;

export class ProcessingError extends Error {
  readonly code: ProcessingErrorCode;
  // Technical detail for server logs only. Never stored or shown.
  readonly detail?: string;

  constructor(code: ProcessingErrorCode, detail?: string) {
    super(PROCESSING_ERROR_MESSAGES[code]);
    this.name = "ProcessingError";
    this.code = code;
    this.detail = detail;
  }
}

export function toProcessingError(error: unknown, fallback: ProcessingErrorCode = "UNKNOWN") {
  if (error instanceof ProcessingError) return error;
  return new ProcessingError(fallback, error instanceof Error ? error.message : String(error));
}
