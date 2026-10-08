import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getPerformance } from "@/lib/performance/queries";
import { getMaterialCount, getMaterials, getSubjects } from "@/lib/library/queries";

const RECENT_MATERIALS = 4;

// Uploads from the dashboard start document processing after the response.
export const maxDuration = 300;

export default async function DashboardPage() {
  // The dashboard is the landing page, so a library failure degrades it
  // instead of replacing it with the error screen.
  const library = await Promise.all([
    getSubjects(),
    getMaterials({ limit: RECENT_MATERIALS }),
    getMaterialCount(),
  ]).catch(() => null);
  // Shown when available; never a reason for the dashboard to fail.
  const performance = await getPerformance().catch(() => null);
  const [subjects, recentMaterials, materialCount] = library ?? [[], [], 0];

  return (
    <DashboardView
      loadFailed={!library}
      materialCount={materialCount}
      performance={performance}
      recentMaterials={recentMaterials}
      subjects={subjects}
    />
  );
}
