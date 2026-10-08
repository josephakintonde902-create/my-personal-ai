"use server";

import { getCurrentUser } from "@/lib/auth/dal";
import { isUuid } from "@/lib/library/files";
import type { ActionResult } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const DELETE_FAILED = "We couldn't delete this conversation. Please try again.";

// Deletes one of the signed-in user's conversations. Its messages are removed
// with it by the database (on delete cascade). Deleting a conversation that is
// already gone, or that belongs to someone else, changes nothing and is
// reported as done: either way it is no longer in this user's list.
export async function deleteConversation(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase.from("tutor_conversations").delete().eq("user_id", user.id).eq("id", id);
  if (error) {
    console.error("[tutor] conversation delete failed", { code: error.code });
    return { ok: false, error: DELETE_FAILED };
  }

  // Nothing is revalidated: the tutor page keeps its own conversation list up
  // to date, and refreshing it here would interrupt an answer being streamed.
  return { ok: true };
}
