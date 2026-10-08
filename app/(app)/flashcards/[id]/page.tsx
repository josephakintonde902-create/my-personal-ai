import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeckReview } from "@/components/practice/deck-review";
import { getDeckPage } from "@/lib/ai/practice/queries";
import { getSubject } from "@/lib/library/queries";

export const metadata: Metadata = { title: "Flashcards — Ari" };

type Props = { params: Promise<{ id: string }> };

export default async function DeckPage({ params }: Props) {
  const { id } = await params;

  // Null for an unknown id, a malformed id, and another user's deck alike.
  const page = await getDeckPage(id);
  if (!page) notFound();

  const subject = page.deck.subjectId ? await getSubject(page.deck.subjectId).catch(() => null) : null;

  return (
    <div className="dashboard library-page">
      <DeckReview cards={page.cards} deck={page.deck} subjectName={subject?.name ?? null} />
    </div>
  );
}
