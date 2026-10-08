import type { Metadata } from "next";
import { PerformanceView } from "@/components/performance/performance-view";
import { getPerformance } from "@/lib/performance/queries";

export const metadata: Metadata = { title: "Performance — Ari" };

// Shows the signed-in student how they are doing, worked out from their own
// quiz answers and flashcard reviews. No AI model is involved.
export default async function PerformancePage() {
  const report = await getPerformance();

  return (
    <div className="dashboard library-page">
      {report ? (
        <PerformanceView report={report} />
      ) : (
        <div className="form-message error" role="alert">We couldn&apos;t load your performance just now. Refresh the page to try again.</div>
      )}
    </div>
  );
}
