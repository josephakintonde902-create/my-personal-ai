import type { ExtractedDocument } from "./types";

// Plain text has no declared encoding, so this checks for a byte-order mark,
// then tries strict UTF-8, and falls back to Windows-1252 (the usual encoding
// of older notes saved on Windows) rather than producing garbled characters.
export function decodeText(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// Paragraphs are separated by blank lines.
export function splitParagraphs(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function extractTxt(bytes: Uint8Array): ExtractedDocument {
  const paragraphs = splitParagraphs(decodeText(bytes));
  return { units: [{ blocks: paragraphs.map((text) => ({ kind: "paragraph", text })) }] };
}
