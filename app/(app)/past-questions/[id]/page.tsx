import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CollectionView } from "@/components/past-questions/collection-view";
import { getPastSetPage } from "@/lib/past-questions/queries";

export const metadata: Metadata = { title: "Past questions — Ari" };

// "Analyse with Ari" and "Try again" call the chat model and re-read the
// paper from Server Actions on this page.
export const maxDuration = 300;

type Props = { params: Promise<{ id: string }> };

export default async function PastQuestionSetPage({ params }: Props) {
  const { id } = await params;

  // Null for an unknown id, a malformed id, and another user's collection alike.
  const page = await getPastSetPage(id);
  if (!page) notFound();

  return (
    <div className="dashboard library-page">
      <CollectionView {...page} />
    </div>
  );
}
