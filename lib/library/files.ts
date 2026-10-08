import {
  MATERIAL_TITLE_MAX_LENGTH,
  MAX_MATERIAL_FILE_SIZE,
  SUPPORTED_MATERIAL_TYPES,
  SUPPORTED_TYPES_LABEL,
} from "./config";
import type { SupportedMaterialType } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_STORAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_BASE_MAX_LENGTH = 80;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function getFileExtension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function findTypeByExtension(extension: string): SupportedMaterialType | undefined {
  return SUPPORTED_MATERIAL_TYPES.find((type) => (type.extensions as readonly string[]).includes(extension));
}

export function findTypeByMime(mimeType: string): SupportedMaterialType | undefined {
  return SUPPORTED_MATERIAL_TYPES.find((type) => type.mimeType === mimeType);
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export const MAX_FILE_SIZE_LABEL = formatFileSize(MAX_MATERIAL_FILE_SIZE);

type FileCheck = { ok: true; type: SupportedMaterialType } | { ok: false; error: string };

// Checks the three things the browser reports about a file: its extension,
// its MIME type, and its size. `sniffFileType` then checks the actual bytes.
export function validateMaterialFile(file: { name: string; type: string; size: number }): FileCheck {
  const extension = getFileExtension(file.name);
  const type = findTypeByExtension(extension);

  if (!type) {
    return {
      ok: false,
      error: extension
        ? `.${extension} files aren't supported. Upload one of: ${SUPPORTED_TYPES_LABEL}.`
        : `This file has no extension. Upload one of: ${SUPPORTED_TYPES_LABEL}.`,
    };
  }

  // Some browsers report an empty type for Office files; that is allowed
  // because the content check below still runs. A type that contradicts the
  // extension is not.
  if (file.type && file.type !== type.mimeType) {
    return { ok: false, error: `This file's contents don't match its .${extension} extension.` };
  }
  if (file.size === 0) return { ok: false, error: "This file is empty." };
  if (file.size > MAX_MATERIAL_FILE_SIZE) {
    return {
      ok: false,
      error: `This file is ${formatFileSize(file.size)}. The maximum size is ${MAX_FILE_SIZE_LABEL}.`,
    };
  }

  return { ok: true, type };
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// Confirms the file's leading bytes look like the type its name claims, so a
// renamed file (photo.exe → notes.pdf) is rejected before it is uploaded.
export async function sniffFileType(file: Blob, type: SupportedMaterialType): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());

  switch (type.id) {
    case "pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "docx":
    case "pptx":
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]); // ZIP container
    case "ppt":
      return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // OLE compound file
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
    case "txt":
      return !bytes.includes(0); // text has no NUL bytes
  }
}

// Builds the object name used in storage. The user's filename is never used
// as-is: accents are folded, anything outside [a-z0-9._-] becomes a dash, and
// the length is capped. Names in other scripts fall back to "file". The
// extension always comes from the validated type, not from the input.
export function toSafeStorageName(filename: string, extension: string) {
  const dot = filename.lastIndexOf(".");
  const base = (dot > 0 ? filename.slice(0, dot) : filename)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SAFE_BASE_MAX_LENGTH)
    .replace(/-+$/, "");

  return `${base || "file"}.${extension}`;
}

export function isSafeStorageName(name: unknown): name is string {
  return typeof name === "string" && SAFE_STORAGE_NAME.test(name) && !name.includes("..");
}

// Uniqueness comes from the material id folder, so two uploads of the same
// filename never collide.
export function buildMaterialPath(userId: string, subjectId: string, materialId: string, storageName: string) {
  return `${userId}/${subjectId}/${materialId}/${storageName}`;
}

// The filename as shown to the user: control characters and path separators
// removed, length capped. Unicode is preserved.
export function cleanOriginalFilename(filename: string) {
  const cleaned = filename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return (cleaned || "file").slice(0, 255);
}

export function titleFromFilename(filename: string) {
  const dot = filename.lastIndexOf(".");
  const base = (dot > 0 ? filename.slice(0, dot) : filename).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "Untitled material").slice(0, MATERIAL_TITLE_MAX_LENGTH);
}
