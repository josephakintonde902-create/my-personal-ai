import "server-only";

import { STALE_PROCESSING_MINUTES } from "@/lib/ai/config";
import { getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { inspectIndex, reportMaterials } from "@/lib/ai/retrieval/index-health";
import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "./files";
import type { StudyMaterial, Subject, SubjectWithCount } from "./types";

// Every query here runs as the signed-in user, so Row Level Security limits
// the results to that user's rows. The explicit user_id filters state the
// intent and let Postgres use the user_id indexes.

const SUBJECT_COLUMNS = "id, user_id, name, description, color, icon, created_at, updated_at";
const MATERIAL_COLUMNS =
  "id, user_id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension, processing_status, processing_error, processing_started_at, processed_at, page_count, word_count, chunk_count, created_at, updated_at";

function withStaleFlag(row: Omit<StudyMaterial, "processing_stale" | "needs_reprocess">): StudyMaterial {
  const startedAt = row.processing_started_at ? Date.parse(row.processing_started_at) : 0;
  return {
    ...row,
    needs_reprocess: false,
    processing_stale:
      row.processing_status === "processing" && Date.now() - startedAt > STALE_PROCESSING_MINUTES * 60_000,
  };
}

type SubjectRow = Subject & { study_materials: { count: number }[] };

function withCount({ study_materials, ...subject }: SubjectRow): SubjectWithCount {
  return { ...subject, material_count: study_materials[0]?.count ?? 0 };
}

export async function getSubjects(): Promise<SubjectWithCount[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("subjects")
    .select(`${SUBJECT_COLUMNS}, study_materials(count)`)
    .eq("user_id", user.id)
    .order("name");

  if (error) {
    console.error("[library] subjects load failed", { code: error.code });
    throw new Error("Could not load subjects.");
  }
  return (data as unknown as SubjectRow[]).map(withCount);
}

// Returns null when the subject does not exist OR belongs to someone else.
// The two cases are deliberately indistinguishable to the caller.
export async function getSubject(id: string): Promise<SubjectWithCount | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(id)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("subjects")
    .select(`${SUBJECT_COLUMNS}, study_materials(count)`)
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[library] subject load failed", { code: error.code });
    throw new Error("Could not load the subject.");
  }
  return data ? withCount(data as unknown as SubjectRow) : null;
}

// The ready materials the search in use cannot reach. Two cheap counts in
// the normal case; the per-material scan only runs when they disagree. A
// failure here never hides the library: the flag is simply left off.
async function findUnsearchable(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<Set<string>> {
  try {
    let model: string;
    try {
      model = getEmbeddingProvider().model;
    } catch {
      // No embedding provider: nothing can be processed or searched at all,
      // which the page already says in its own way.
      return new Set();
    }
    const health = await inspectIndex(supabase, userId, {}, model);
    if (health.readyMaterials === 0) return new Set();
    // Something is indexed and all of it is searchable: the normal case.
    if (health.chunks > 0 && health.searchableChunks >= health.chunks) return new Set();
    const report = await reportMaterials(supabase, userId, model);
    return new Set(report.filter((material) => material.searchableChunks === 0).map((material) => material.id));
  } catch (error) {
    console.error("[library] index check failed", { detail: (error as Error).message });
    return new Set();
  }
}

export async function getMaterials(options: { subjectId?: string; limit?: number; checkIndex?: boolean } = {}): Promise<StudyMaterial[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  let query = supabase
    .from("study_materials")
    .select(MATERIAL_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (options.subjectId) query = query.eq("subject_id", options.subjectId);
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) {
    console.error("[library] materials load failed", { code: error.code });
    throw new Error("Could not load study materials.");
  }
  const materials = (data as Omit<StudyMaterial, "processing_stale" | "needs_reprocess">[]).map(withStaleFlag);
  if (!options.checkIndex || !materials.some((material) => material.processing_status === "ready")) return materials;

  const unsearchable = await findUnsearchable(supabase, user.id);
  return materials.map((material) => ({ ...material, needs_reprocess: material.processing_status === "ready" && unsearchable.has(material.id) }));
}

export async function getMaterialCount(): Promise<number> {
  const user = await getCurrentUser();
  if (!user) return 0;

  const supabase = await createClient();
  const { count, error } = await supabase
    .from("study_materials")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (error) {
    console.error("[library] material count failed", { code: error.code });
    throw new Error("Could not load study materials.");
  }
  return count ?? 0;
}
