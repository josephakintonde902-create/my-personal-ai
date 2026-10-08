"use server";

import { toResult, type PracticeResult } from "@/lib/ai/practice/errors";
import { generateDeck, reviewCard } from "@/lib/ai/practice/flashcard-service";
import { practiceDeps } from "@/lib/ai/practice/queries";
import type { GenerateDeckInput, Rating } from "@/lib/ai/practice/types";
import { getCurrentUser } from "@/lib/auth/dal";
import { isUuid } from "@/lib/library/files";
import type { ActionResult } from "@/lib/library/types";
import { createClient } from "@/lib/supabase/server";

// Thin wrappers around lib/ai/practice, as in the quiz actions. The student
// is always the session's user.

export async function generateDeckAction(input: GenerateDeckInput): Promise<PracticeResult<{ deckId: string; delivered: number; requested: number }>> {
  return toResult("deck generation", async () => {
    const { deck, delivered, requested } = await generateDeck(input, practiceDeps());
    return { deckId: deck.id, delivered, requested };
  });
}

export async function reviewCardAction(flashcardId: string, rating: Rating): Promise<PracticeResult<{ id: string; reviewedAt: string }>> {
  return toResult("card review", () => reviewCard({ flashcardId, rating }, practiceDeps()));
}

// Deletes one of the signed-in user's decks. Its cards and their reviews are
// removed with it by the database (on delete cascade).
export async function deleteDeckAction(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  if (!isUuid(id)) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase.from("flashcard_decks").delete().eq("user_id", user.id).eq("id", id);
  if (error) {
    console.error("[practice] deck delete failed", { code: error.code });
    return { ok: false, error: "We couldn't delete this deck. Please try again." };
  }
  return { ok: true };
}
