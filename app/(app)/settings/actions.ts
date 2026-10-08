"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/dal";
import { formText, validateBio, validateFullName } from "@/lib/auth/validation";
import { AVATAR_BUCKET, avatarPath } from "@/lib/profile/avatar";
import { createClient } from "@/lib/supabase/server";

export type ProfileFormState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: { fullName?: string; bio?: string };
};

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const SAVE_FAILED = "We couldn't save your changes. Please try again.";

export async function updateProfile(_previous: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  // The row to update is chosen from the verified session, never from the form.
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: SESSION_EXPIRED };

  const fullName = formText(formData, "fullName");
  const bio = formText(formData, "bio");

  const fieldErrors = { fullName: validateFullName(fullName), bio: validateBio(bio) };
  if (fieldErrors.fullName || fieldErrors.bio) return { status: "error", fieldErrors };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("profiles")
      .update({ full_name: fullName, bio: bio || null })
      .eq("id", user.id)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      console.error("[profile] update failed", { code: error?.code, missingRow: !data });
      return { status: "error", message: SAVE_FAILED };
    }
  } catch {
    console.error("[profile] update failed");
    return { status: "error", message: SAVE_FAILED };
  }

  revalidatePath("/", "layout");
  return { status: "success", message: "Profile saved." };
}

// Called after the browser has uploaded the image to the user's own folder.
// Takes no arguments: the URL is derived from the session, so a client cannot
// point its profile at an arbitrary address.
export async function saveAvatar(): Promise<{ error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: SESSION_EXPIRED };

  try {
    const supabase = await createClient();
    const { data: publicUrl } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath(user.id));
    // The version parameter makes browsers pick up a replaced image.
    const avatarUrl = `${publicUrl.publicUrl}?v=${Date.now()}`;

    const { error } = await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", user.id);
    if (error) {
      console.error("[profile] avatar save failed", { code: error.code });
      return { error: SAVE_FAILED };
    }
  } catch {
    console.error("[profile] avatar save failed");
    return { error: SAVE_FAILED };
  }

  revalidatePath("/", "layout");
  return {};
}

export async function removeAvatar(): Promise<{ error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: SESSION_EXPIRED };

  try {
    const supabase = await createClient();
    const { error: storageError } = await supabase.storage.from(AVATAR_BUCKET).remove([avatarPath(user.id)]);
    if (storageError) console.error("[profile] avatar file removal failed", { name: storageError.name });

    const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", user.id);
    if (error) {
      console.error("[profile] avatar removal failed", { code: error.code });
      return { error: SAVE_FAILED };
    }
  } catch {
    console.error("[profile] avatar removal failed");
    return { error: SAVE_FAILED };
  }

  revalidatePath("/", "layout");
  return {};
}
