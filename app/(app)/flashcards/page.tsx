import type { Metadata } from "next";
import { FlashcardsView } from "@/components/practice/flashcards-view";
import { getDeckList, getPracticeOptions } from "@/lib/ai/practice/queries";
import { isTutorConfigured } from "@/lib/ai/tutor/provider";

export const metadata: Metadata = { title: "Flashcards — Ari" };

// Creating a deck calls the chat model from a Server Action on this page.
// This is how long the platform should let that run.
export const maxDuration = 300;

export default async function FlashcardsPage() {
  // A failure to load the decks degrades the page instead of replacing it
  // with the error screen.
  const [{ subjects, materials }, decks] = await Promise.all([getPracticeOptions(), getDeckList().catch(() => null)]);

  return (
    <div className="dashboard library-page">
      <FlashcardsView decks={decks ?? []} enabled={isTutorConfigured()} listFailed={!decks} materials={materials} subjects={subjects} />
    </div>
  );
}
