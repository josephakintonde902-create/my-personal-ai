"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/dal";
import {
  SUBJECT_COLORS,
  SUBJECT_DESCRIPTION_MAX_LENGTH,
  SUBJECT_ICONS,
  SUBJECT_NAME_MAX_LENGTH,
} from "@/lib/library/config";
import { isUuid } from "@/lib/library/files";
import { findUntrackedFiles, removeMaterialFiles } from "@/lib/library/storage";
import type { ActionResult } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";

export type SubjectInput = {
  name: string;
  description: string;
  color: string;
  icon: string;
};

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const SAVE_FAILED = "We couldn't save this subject. Please try again.";
const DELETE_FAILED = "We couldn't delete this subject. Nothing was removed. Please try again.";
const NOT_FOUND = "This subject no longer exists.";
const UNIQUE_VIOLATION = "23505";

type SubjectValues = { name: string; description: string | null; color: string | null; icon: string | null };

// Accepts untrusted input and returns only values that are safe to store.
function parseSubject(input: SubjectInput): { values: SubjectValues } | { fieldErrors: Record<string, string> } {
  const name = String(input?.name ?? "").replace(/\s+/g, " ").trim();
  const description = String(input?.description ?? "").trim();
  const color = String(input?.color ?? "");
  const icon = String(input?.icon ?? "");

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Give your subject a name.";
  else if (name.length > SUBJECT_NAME_MAX_LENGTH) fieldErrors.name = `Use ${SUBJECT_NAME_MAX_LENGTH} characters or fewer.`;
  if (description.length > SUBJECT_DESCRIPTION_MAX_LENGTH) {
    fieldErrors.description = `Use ${SUBJECT_DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  return {
    values: {
      name,
      description: description || null,
      // Unknown keys are dropped rather than stored.
      color: SUBJECT_COLORS.some((option) => option.id === color) ? color : null,
      icon: SUBJECT_ICONS.some((option) => option.id === icon) ? icon : null,
    },
  };
}

function revalidateLibrary() {
  revalidatePath("/subjects", "layout");
  revalidatePath("/materials");
  revalidatePath("/dashboard");
}

export async function createSubject(input: SubjectInput): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };

  const parsed = parseSubject(input);
  if ("fieldErrors" in parsed) return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };

  try {
    const supabase = await createClient();
    // user_id is not sent: the database fills it in from the session.
    const { data, error } = await supabase.from("subjects").insert(parsed.values).select("id").single();

    if (error?.code === UNIQUE_VIOLATION) {
      return { ok: false, error: "Check the highlighted fields.", fieldErrors: { name: "You already have a subject with this name." } };
    }
    if (error || !data) {
      console.error("[subjects] create failed", { code: error?.code });
      return { ok: false, error: SAVE_FAILED };
    }

    revalidateLibrary();
    return { ok: true, data: { id: data.id } };
  } catch {
    console.error("[subjects] create failed");
    return { ok: false, error: SAVE_FAILED };
  }
}

export async function updateSubject(id: string, input: SubjectInput): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  const parsed = parseSubject(input);
  if ("fieldErrors" in parsed) return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("subjects")
      .update(parsed.values)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();

    if (error?.code === UNIQUE_VIOLATION) {
      return { ok: false, error: "Check the highlighted fields.", fieldErrors: { name: "You already have a subject with this name." } };
    }
    if (error) {
      console.error("[subjects] update failed", { code: error.code });
      return { ok: false, error: SAVE_FAILED };
    }
    // No row: it was deleted, or it belongs to someone else. Same answer either way.
    if (!data) return { ok: false, error: NOT_FOUND };

    revalidateLibrary();
    return { ok: true };
  } catch {
    console.error("[subjects] update failed");
    return { ok: false, error: SAVE_FAILED };
  }
}

// Deleting a subject cascades to its study_materials rows in the database,
// but the database cannot delete storage files. So files go first: if any
// file cannot be removed, the subject is kept and the user can retry. The
// reverse order could leave files with nothing pointing at them.
export async function deleteSubject(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  try {
    const supabase = await createClient();

    const { data: subject, error: subjectError } = await supabase
      .from("subjects")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (subjectError) {
      console.error("[subjects] delete lookup failed", { code: subjectError.code });
      return { ok: false, error: DELETE_FAILED };
    }
    if (!subject) return { ok: false, error: NOT_FOUND };

    const { data: materials, error: materialsError } = await supabase
      .from("study_materials")
      .select("id, file_path")
      .eq("subject_id", id)
      .eq("user_id", user.id);
    if (materialsError) {
      console.error("[subjects] delete materials lookup failed", { code: materialsError.code });
      return { ok: false, error: DELETE_FAILED };
    }

    const untracked = await findUntrackedFiles(supabase, user.id, id, new Set(materials.map((material) => material.id)));
    if (!untracked) return { ok: false, error: DELETE_FAILED };

    const removed = await removeMaterialFiles(supabase, [...materials.map((material) => material.file_path), ...untracked]);
    if (!removed) return { ok: false, error: DELETE_FAILED };

    const { error: deleteError } = await supabase.from("subjects").delete().eq("id", id).eq("user_id", user.id);
    if (deleteError) {
      console.error("[subjects] delete failed", { code: deleteError.code });
      return { ok: false, error: "The files were removed but the subject couldn't be deleted. Please try again." };
    }

    revalidateLibrary();
    return { ok: true };
  } catch {
    console.error("[subjects] delete failed");
    return { ok: false, error: DELETE_FAILED };
  }
}
