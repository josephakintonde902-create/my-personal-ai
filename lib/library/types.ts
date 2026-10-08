import type { SUBJECT_COLORS, SUBJECT_ICONS, SUPPORTED_MATERIAL_TYPES } from "./config";

export type SupportedMaterialType = (typeof SUPPORTED_MATERIAL_TYPES)[number];
export type SubjectColor = (typeof SUBJECT_COLORS)[number]["id"];
export type SubjectIcon = (typeof SUBJECT_ICONS)[number]["id"];

export const PROCESSING_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

// Row shapes for public.subjects and public.study_materials.

export type Subject = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
};

export type SubjectWithCount = Subject & { material_count: number };

export type StudyMaterial = {
  id: string;
  user_id: string;
  subject_id: string;
  title: string;
  original_filename: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  file_extension: string | null;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  processing_started_at: string | null;
  processed_at: string | null;
  // Pages for a PDF, slides for a PPTX or PPT.
  page_count: number | null;
  word_count: number | null;
  chunk_count: number | null;
  created_at: string;
  updated_at: string;
  // Not a column: true when a 'processing' attempt has run for so long that
  // it is assumed to have died and can be retried. Set by getMaterials().
  processing_stale: boolean;
  // Not a column: true when the material shows "Ready" but the search in use
  // cannot reach it, because nothing is indexed for it or its passages were
  // embedded by a different model. Reprocessing fixes both. Only worked out
  // when getMaterials() is asked to check the index.
  needs_reprocess: boolean;
};

// What the UI needs to pick a subject (upload dialog, filters).
export type SubjectOption = Pick<Subject, "id" | "name" | "color" | "icon">;

// Result of a Server Action that changes data.
export type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string | undefined> };
