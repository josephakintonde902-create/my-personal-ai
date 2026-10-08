// Single source of truth for what can be uploaded and how subjects can look.
//
// The storage bucket enforces the same size limit and MIME list on the server
// (supabase/migrations/*_create_study_materials_bucket.sql). If you change
// MAX_MATERIAL_FILE_SIZE or SUPPORTED_MATERIAL_TYPES, update the bucket in a
// new migration too.

export const MATERIALS_BUCKET = "study-materials";

export const MAX_MATERIAL_FILE_SIZE = 50 * 1024 * 1024;

// How long a download link stays valid, in seconds.
export const MATERIAL_DOWNLOAD_URL_TTL = 60;

export const SUPPORTED_MATERIAL_TYPES = [
  {
    id: "pdf",
    label: "PDF",
    kind: "document",
    mimeType: "application/pdf",
    extensions: ["pdf"],
  },
  {
    id: "docx",
    label: "DOCX",
    kind: "document",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
  },
  {
    id: "pptx",
    label: "PPTX",
    kind: "document",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: ["pptx"],
  },
  {
    // PowerPoint 97–2003. Newer presentations are PPTX, above.
    id: "ppt",
    label: "PPT",
    kind: "document",
    mimeType: "application/vnd.ms-powerpoint",
    extensions: ["ppt"],
  },
  {
    id: "txt",
    label: "TXT",
    kind: "document",
    mimeType: "text/plain",
    extensions: ["txt"],
  },
  {
    id: "png",
    label: "PNG",
    kind: "image",
    mimeType: "image/png",
    extensions: ["png"],
  },
  {
    id: "jpg",
    label: "JPG",
    kind: "image",
    mimeType: "image/jpeg",
    extensions: ["jpg", "jpeg"],
  },
  {
    id: "webp",
    label: "WebP",
    kind: "image",
    mimeType: "image/webp",
    extensions: ["webp"],
  },
] as const;

export const SUPPORTED_TYPES_LABEL = SUPPORTED_MATERIAL_TYPES.map((type) => type.label).join(", ");

// Value for a file input's `accept` attribute.
export const MATERIAL_ACCEPT = SUPPORTED_MATERIAL_TYPES.flatMap((type) => [
  type.mimeType,
  ...type.extensions.map((extension) => `.${extension}`),
]).join(",");

export const SUBJECT_NAME_MAX_LENGTH = 80;
export const SUBJECT_DESCRIPTION_MAX_LENGTH = 500;
export const MATERIAL_TITLE_MAX_LENGTH = 150;

// Stored in subjects.color / subjects.icon as keys. Styling for each color
// key lives in globals.css (.tone-<key>).
export const SUBJECT_COLORS = [
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
  { id: "amber", label: "Amber" },
  { id: "slate", label: "Slate" },
] as const;

export const SUBJECT_ICONS = [
  { id: "book", label: "Book", glyph: "📘" },
  { id: "calculator", label: "Maths", glyph: "🧮" },
  { id: "flask", label: "Science", glyph: "🧪" },
  { id: "dna", label: "Biology", glyph: "🧬" },
  { id: "eye", label: "Vision", glyph: "👁" },
  { id: "health", label: "Health", glyph: "🩺" },
  { id: "globe", label: "Geography", glyph: "🌍" },
  { id: "scales", label: "Law", glyph: "⚖️" },
  { id: "chart", label: "Business", glyph: "📊" },
  { id: "code", label: "Computing", glyph: "💻" },
  { id: "pen", label: "Writing", glyph: "✏️" },
  { id: "language", label: "Languages", glyph: "💬" },
] as const;

export const DEFAULT_SUBJECT_COLOR = SUBJECT_COLORS[0].id;
