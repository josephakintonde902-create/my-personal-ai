import type { Metadata } from "next";
import { PastQuestionsView } from "@/components/past-questions/past-questions-view";
import { getPastQuestionsPage } from "@/lib/past-questions/queries";

export const metadata: Metadata = { title: "Past questions — Ari" };

// An upload here starts reading the paper (and labelling its topics) on the
// server after the response. This is how long the platform should let that run.
export const maxDuration = 300;

// /past-questions          every collection
// /past-questions?q=nerve  plus the questions whose wording matches
type Props = { searchParams: Promise<{ q?: string | string[] }> };

export default async function PastQuestionsPage({ searchParams }: Props) {
  const { q } = await searchParams;
  const page = await getPastQuestionsPage(typeof q === "string" ? q : null).catch((error: Error) => {
    console.error("[past-questions] page load failed", { detail: error.message });
    return null;
  });

  return (
    <div className="dashboard library-page">
      {page ? (
        <PastQuestionsView {...page} />
      ) : (
        <div className="form-message error" role="alert">We couldn&apos;t load your past questions just now. Refresh the page to try again.</div>
      )}
    </div>
  );
}
