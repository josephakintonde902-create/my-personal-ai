"use server";

import { revalidatePath } from "next/cache";
import { isProcessingConfigured, scheduleMaterialProcessing } from "@/lib/ai/processing/run";
import { getCurrentUser } from "@/lib/auth/dal";
import {
  MATERIAL_DOWNLOAD_URL_TTL,
  MATERIAL_TITLE_MAX_LENGTH,
  MATERIALS_BUCKET,
  MAX_MATERIAL_FILE_SIZE,
} from "@/lib/library/config";
import {
  buildMaterialPath,
  cleanOriginalFilename,
  findTypeByExtension,
  getFileExtension,
  isSafeStorageName,
  isUuid,
  titleFromFilename,
} from "@/lib/library/files";
import { removeMaterialFiles } from "@/lib/library/storage";
import type { ActionResult } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const NOT_FOUND = "This material no longer exists.";
const REGISTER_FAILED = "The file uploaded but we couldn't add it to your library, so it was removed. Please try again.";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RLS_VIOLATION = "42501";

function revalidateLibrary() {
  revalidatePath("/subjects", "layout");
  revalidatePath("/materials");
  revalidatePath("/dashboard");
}

export type RegisterMaterialInput = {
  materialId: string;
  subjectId: string;
  storageName: string;
  originalFilename: string;
};

// Step two of an upload. The browser has already put the file in storage at
// {user}/{subject}/{material}/{storageName}; this records it in the database.
//
// Nothing about ownership, size or type is taken from the browser. The user
// comes from the session, the path is rebuilt here, and the size and type are
// read back from storage. If the row cannot be created, the file is deleted
// so it is never left untracked.
export async function registerMaterial(input: RegisterMaterialInput): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };

  const { materialId, subjectId, storageName } = input ?? {};
  if (!isUuid(materialId) || !isUuid(subjectId) || !isSafeStorageName(storageName)) {
    return { ok: false, error: "That upload wasn't valid. Please try again." };
  }

  const extension = getFileExtension(storageName);
  const type = findTypeByExtension(extension);
  const filePath = buildMaterialPath(user.id, subjectId, materialId, storageName);

  try {
    const supabase = await createClient();
    const discard = () => removeMaterialFiles(supabase, [filePath]);

    if (!type) {
      await discard();
      return { ok: false, error: "That file type isn't supported." };
    }

    const { data: info, error: infoError } = await supabase.storage.from(MATERIALS_BUCKET).info(filePath);
    if (infoError || !info) {
      console.error("[materials] uploaded file not found", { name: infoError?.name });
      return { ok: false, error: "We couldn't find the uploaded file. Please try again." };
    }

    // The client library has returned this field under both spellings.
    const stored = info as { size?: number; contentType?: string; content_type?: string };
    const size = stored.size ?? 0;
    const contentType = stored.contentType ?? stored.content_type ?? "";

    if (size <= 0 || size > MAX_MATERIAL_FILE_SIZE || contentType !== type.mimeType) {
      await discard();
      return { ok: false, error: "That file isn't a supported type or size, so it was removed." };
    }

    const originalFilename = cleanOriginalFilename(String(input.originalFilename ?? storageName));
    const { error } = await supabase.from("study_materials").insert({
      id: materialId,
      subject_id: subjectId,
      title: titleFromFilename(originalFilename),
      original_filename: originalFilename,
      file_path: filePath,
      mime_type: type.mimeType,
      file_size: size,
      file_extension: extension,
      // user_id and processing_status are set by the database
      // (auth.uid() and 'pending'); clients cannot write either column.
    });

    // Already registered (a repeated request). The file belongs to that
    // existing row, so it must not be discarded.
    if (error?.code === UNIQUE_VIOLATION) return { ok: true };

    if (error) {
      console.error("[materials] register failed", { code: error.code });
      await discard();
      if (error.code === FOREIGN_KEY_VIOLATION || error.code === RLS_VIOLATION) {
        return { ok: false, error: "That subject no longer exists, so the file was removed. Choose another subject." };
      }
      return { ok: false, error: REGISTER_FAILED };
    }

    // Start turning the file into searchable knowledge. This runs on the
    // server after the response is sent; the upload does not wait for it.
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session) scheduleMaterialProcessing(materialId, sessionData.session.access_token);

    revalidateLibrary();
    return { ok: true };
  } catch {
    console.error("[materials] register failed");
    return { ok: false, error: "We couldn't add the file to your library. Please try again." };
  }
}

export async function renameMaterial(id: string, title: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  const cleanTitle = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!cleanTitle) return { ok: false, error: "Check the title.", fieldErrors: { title: "Give this material a title." } };
  if (cleanTitle.length > MATERIAL_TITLE_MAX_LENGTH) {
    return { ok: false, error: "Check the title.", fieldErrors: { title: `Use ${MATERIAL_TITLE_MAX_LENGTH} characters or fewer.` } };
  }

  try {
    const supabase = await createClient();
    // Only the title changes. The stored file and original filename are untouched.
    const { data, error } = await supabase
      .from("study_materials")
      .update({ title: cleanTitle })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[materials] rename failed", { code: error.code });
      return { ok: false, error: "We couldn't rename this material. Please try again." };
    }
    if (!data) return { ok: false, error: NOT_FOUND };

    revalidateLibrary();
    return { ok: true };
  } catch {
    console.error("[materials] rename failed");
    return { ok: false, error: "We couldn't rename this material. Please try again." };
  }
}

// Starts (or restarts) processing for one of the caller's materials: used by
// "Retry" after a failure and "Reprocess" on a ready material. The work runs
// on the server after this returns; the page polls for the new status.
//
// Ownership is enforced where the work begins: the database function that
// claims the material only matches rows owned by the session's user, and
// refuses a material that is already being processed.
export async function processMaterialAction(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };
  if (!isProcessingConfigured()) {
    return { ok: false, error: "Processing isn't set up yet. Your material is saved and will be processed once it is." };
  }

  const failed = "We couldn't start processing. Please try again.";
  try {
    const supabase = await createClient();
    const { data: material, error } = await supabase
      .from("study_materials")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("[materials] process lookup failed", { code: error.code });
      return { ok: false, error: failed };
    }
    if (!material) return { ok: false, error: NOT_FOUND };

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return { ok: false, error: SESSION_EXPIRED };

    scheduleMaterialProcessing(id, sessionData.session.access_token);
    return { ok: true };
  } catch {
    console.error("[materials] process start failed");
    return { ok: false, error: failed };
  }
}

// File first, then the row. If the file cannot be removed the row is kept, so
// the material stays visible and the delete can be retried. Removing a file
// that is already gone is not an error, so a retry always converges.
export async function deleteMaterial(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  const failed = "We couldn't delete this material. Please try again.";
  try {
    const supabase = await createClient();
    const { data: material, error: lookupError } = await supabase
      .from("study_materials")
      .select("id, file_path")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) {
      console.error("[materials] delete lookup failed", { code: lookupError.code });
      return { ok: false, error: failed };
    }
    if (!material) return { ok: false, error: NOT_FOUND };

    const removed = await removeMaterialFiles(supabase, [material.file_path]);
    if (!removed) return { ok: false, error: failed };

    const { error } = await supabase.from("study_materials").delete().eq("id", id).eq("user_id", user.id);
    if (error) {
      console.error("[materials] delete failed", { code: error.code });
      return { ok: false, error: failed };
    }

    revalidateLibrary();
    return { ok: true };
  } catch {
    console.error("[materials] delete failed");
    return { ok: false, error: failed };
  }
}

// Returns a link that downloads the caller's own file and expires shortly
// after. The bucket is private, so this is the only way a file is ever served.
export async function getMaterialDownloadUrl(id: string): Promise<ActionResult<{ url: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  const failed = "We couldn't prepare this download. Please try again.";
  try {
    const supabase = await createClient();
    const { data: material, error: lookupError } = await supabase
      .from("study_materials")
      .select("file_path, original_filename")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (lookupError) {
      console.error("[materials] download lookup failed", { code: lookupError.code });
      return { ok: false, error: failed };
    }
    if (!material) return { ok: false, error: NOT_FOUND };

    const { data, error } = await supabase.storage
      .from(MATERIALS_BUCKET)
      .createSignedUrl(material.file_path, MATERIAL_DOWNLOAD_URL_TTL, { download: material.original_filename });

    if (error || !data?.signedUrl) {
      console.error("[materials] signed url failed", { name: error?.name });
      return { ok: false, error: failed };
    }
    return { ok: true, data: { url: data.signedUrl } };
  } catch {
    console.error("[materials] download failed");
    return { ok: false, error: failed };
  }
}
