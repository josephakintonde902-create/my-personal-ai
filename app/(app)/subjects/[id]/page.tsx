import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SubjectDetailView } from "@/components/subjects/subject-detail-view";
import { isProcessingConfigured } from "@/lib/ai/processing/run";
import { getMaterials, getSubject } from "@/lib/library/queries";

export const metadata: Metadata = { title: "Subject — Ari" };

// Uploads from this page start document processing, which continues after
// the response. This is how long the platform should let that work run.
export const maxDuration = 300;

type Props = { params: Promise<{ id: string }> };

export default async function SubjectPage({ params }: Props) {
  const { id } = await params;

  // Null for an unknown id, a malformed id, and another user's subject alike.
  const subject = await getSubject(id);
  if (!subject) notFound();

  const materials = await getMaterials({ subjectId: subject.id, checkIndex: true });

  return (
    <div className="dashboard library-page">
      <SubjectDetailView materials={materials} processingEnabled={isProcessingConfigured()} subject={subject} />
    </div>
  );
}
