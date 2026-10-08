import type { Metadata } from "next";
import { ExamSetup } from "@/components/exam/exam-setup";
import { isUuid } from "@/lib/library/files";
import { getExamHome } from "@/lib/past-questions/queries";

export const metadata: Metadata = { title: "Exam mode — Ari" };

// /exam           set up an exam, and the history of those taken
// /exam?set=<id>  the same, with one collection already chosen
type Props = { searchParams: Promise<{ set?: string | string[] }> };

export default async function ExamPage({ searchParams }: Props) {
  const { set } = await searchParams;
  const home = await getExamHome().catch((error: Error) => {
    console.error("[exam] page load failed", { detail: error.message });
    return null;
  });

  return (
    <div className="dashboard library-page">
      {home ? (
        <ExamSetup {...home} initialSetId={isUuid(set) ? set : null} />
      ) : (
        <div className="form-message error" role="alert">We couldn&apos;t load exam mode just now. Refresh the page to try again.</div>
      )}
    </div>
  );
}
