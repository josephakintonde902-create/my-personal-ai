import type { NextRequest } from "next/server";
import { searchKnowledgeBase } from "@/lib/ai/retrieval/search";
import { TUTOR } from "@/lib/ai/tutor/config";
import { handleTutorChat } from "@/lib/ai/tutor/handler";
import { getTutorModel } from "@/lib/ai/tutor/provider";
import { SupabaseTutorStore } from "@/lib/ai/tutor/store";
import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

// How long the platform should let one answer run. A little longer than the
// model's own time limit (TUTOR.responseTimeoutMs), so that limit fires first.
export const maxDuration = 150;

// Asks Ari a question.
//
//   POST /api/tutor/chat
//   { "message": "What is refraction?", "conversationId"?: "...", "subjectId"?: "..." | null, "regenerate"?: true }
//
// There is no user parameter: the student is always the session's user, and
// every lookup (conversation, subject, study materials) runs as that user
// under Row Level Security. The model is called here on the server, so its
// API key never reaches the browser.
//
// The answer is streamed as one JSON event per line; see TutorStreamEvent.
// The steps themselves are in lib/ai/tutor/handler.ts.
export async function POST(request: NextRequest) {
  return handleTutorChat(request, {
    getUser: getCurrentUser,
    openStore: async (userId) => new SupabaseTutorStore(await createClient(), userId),
    search: searchKnowledgeBase,
    getModel: () => getTutorModel({ effort: TUTOR.effort }),
  });
}
