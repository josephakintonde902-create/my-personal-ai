import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { MATERIALS_BUCKET } from "./config";

const REMOVE_BATCH_SIZE = 100;

// Removes files in batches. Removing a path that no longer exists is not an
// error, so this is safe to retry. Returns false if any batch failed.
export async function removeMaterialFiles(supabase: SupabaseClient, paths: string[]) {
  for (let start = 0; start < paths.length; start += REMOVE_BATCH_SIZE) {
    const { error } = await supabase.storage
      .from(MATERIALS_BUCKET)
      .remove(paths.slice(start, start + REMOVE_BATCH_SIZE));

    if (error) {
      console.error("[library] file removal failed", { name: error.name, message: error.message });
      return false;
    }
  }
  return true;
}

// Finds files under {userId}/{subjectId}/ that have no database row (left
// behind if an upload was interrupted before it could be registered). Used
// when a subject is deleted so nothing is orphaned. Returns null on failure.
export async function findUntrackedFiles(
  supabase: SupabaseClient,
  userId: string,
  subjectId: string,
  trackedMaterialIds: Set<string>,
) {
  const bucket = supabase.storage.from(MATERIALS_BUCKET);
  const subjectFolder = `${userId}/${subjectId}`;

  const { data: materialFolders, error } = await bucket.list(subjectFolder, { limit: 1000 });
  if (error) {
    console.error("[library] subject folder listing failed", { name: error.name, message: error.message });
    return null;
  }

  const paths: string[] = [];
  for (const folder of materialFolders ?? []) {
    if (trackedMaterialIds.has(folder.name)) continue;

    const { data: files, error: filesError } = await bucket.list(`${subjectFolder}/${folder.name}`, { limit: 100 });
    if (filesError) {
      console.error("[library] material folder listing failed", { name: filesError.name, message: filesError.message });
      return null;
    }
    for (const file of files ?? []) paths.push(`${subjectFolder}/${folder.name}/${file.name}`);
  }
  return paths;
}
