// The common shape every extractor produces, whatever the file type.
//
// A document is a list of units (PDF pages, PPTX slides, or one unit for a
// DOCX/TXT file). A unit is a list of blocks in reading order. Keeping the
// structure, instead of one big string, is what lets chunks respect headings
// and paragraphs and remember which page or slide they came from.

export type BlockKind = "heading" | "paragraph" | "table" | "notes";

export type Block = {
  kind: BlockKind;
  text: string;
};

export type DocumentUnit = {
  pageNumber?: number;
  slideNumber?: number;
  // A slide's title, used as the section title for its content.
  title?: string;
  blocks: Block[];
};

export type ExtractedDocument = {
  units: DocumentUnit[];
  // Pages or slides in the source, when the format has them.
  pageCount?: number;
  // True when the file has pages or images with no text layer.
  needsOcr?: boolean;
};

export type ExtractionInput = {
  bytes: Uint8Array;
  // The validated type id from lib/library/config.ts ("pdf", "docx", ...).
  typeId: string;
  mimeType: string;
};
