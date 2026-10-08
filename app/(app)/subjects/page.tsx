import type { Metadata } from "next";
import { SubjectsView } from "@/components/subjects/subjects-view";
import { getSubjects } from "@/lib/library/queries";

export const metadata: Metadata = { title: "Subjects — Ari" };

export default async function SubjectsPage() {
  const subjects = await getSubjects();

  return (
    <div className="dashboard library-page">
      <SubjectsView subjects={subjects} />
    </div>
  );
}
