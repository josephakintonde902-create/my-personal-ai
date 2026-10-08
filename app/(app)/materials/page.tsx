import type { Metadata } from "next";
import { MaterialsView } from "@/components/materials/materials-view";
import { isProcessingConfigured } from "@/lib/ai/processing/run";
import { getMaterials, getSubjects } from "@/lib/library/queries";

export const metadata: Metadata = { title: "Study materials — Ari" };

// Uploads from this page start document processing, which continues after
// the response. This is how long the platform should let that work run.
export const maxDuration = 300;

export default async function MaterialsPage() {
  const [subjects, materials] = await Promise.all([getSubjects(), getMaterials({ checkIndex: true })]);

  return (
    <div className="dashboard library-page">
      <MaterialsView materials={materials} processingEnabled={isProcessingConfigured()} subjects={subjects} />
    </div>
  );
}
