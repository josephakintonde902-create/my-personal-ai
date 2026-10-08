import { unzipSync } from "fflate";
import { PROCESSING } from "../config";
import { ProcessingError } from "../errors";

// DOCX and PPTX files are zip archives of XML. This reads only the entries a
// caller asks for, and refuses archives that would expand to an unreasonable
// size (a "zip bomb") before anything is decompressed.
export function readZipEntries(bytes: Uint8Array, wanted: (name: string) => boolean) {
  let total = 0;

  try {
    return unzipSync(bytes, {
      filter(entry) {
        total += entry.originalSize;
        if (total > PROCESSING.maxUnzippedBytes) {
          throw new ProcessingError("DOCUMENT_TOO_LARGE", "archive expands beyond the allowed size");
        }
        return wanted(entry.name);
      },
    });
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError("EXTRACTION_FAILED", `not a readable archive: ${(error as Error).message}`);
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Decodes the character references used in XML and in Mammoth's HTML output.
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

export function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}
