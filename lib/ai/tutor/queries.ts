import "server-only";

import { getCurrentUser } from "@/lib/auth/dal";
import { isUuid } from "@/lib/library/files";
import { createClient } from "@/lib/supabase/server";
import { TUTOR } from "./config";
import { CONVERSATION_COLUMNS, MESSAGE_COLUMNS, toConversation, toMessage } from "./store";
import type { TutorConversation, TutorMessage } from "./types";

// Every query here runs as the signed-in user, so Row Level Security limits
// the results to that user's rows. The explicit user_id filters state the
// intent and let Postgres use the user_id indexes.

export async function getConversations(): Promise<TutorConversation[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tutor_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(TUTOR.conversationListLimit);

  if (error) {
    console.error("[tutor] conversations load failed", { code: error.code });
    throw new Error("Could not load conversations.");
  }
  return data.map(toConversation);
}

// Returns null when the conversation does not exist OR belongs to someone
// else. The two cases are deliberately indistinguishable to the caller.
export async function getConversationWithMessages(
  id: string,
): Promise<{ conversation: TutorConversation; messages: TutorMessage[] } | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(id)) return null;

  const supabase = await createClient();
  const { data: conversation, error } = await supabase
    .from("tutor_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[tutor] conversation load failed", { code: error.code });
    throw new Error("Could not load the conversation.");
  }
  if (!conversation) return null;

  // The most recent messages, then put back in reading order.
  const { data: messages, error: messagesError } = await supabase
    .from("tutor_messages")
    .select(MESSAGE_COLUMNS)
    .eq("user_id", user.id)
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(TUTOR.displayMessageLimit);

  if (messagesError) {
    console.error("[tutor] messages load failed", { code: messagesError.code });
    throw new Error("Could not load the conversation.");
  }
  return { conversation: toConversation(conversation), messages: messages.map(toMessage).reverse() };
}
