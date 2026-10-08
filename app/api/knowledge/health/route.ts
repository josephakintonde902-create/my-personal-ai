import { NextResponse, type NextRequest } from "next/server";
import { embeddingConfigProblem, embeddingModel, embeddingProviderName } from "@/lib/ai/embeddings/provider";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/config";
import { inspectIndex, reportMaterials } from "@/lib/ai/retrieval/index-health";
import { KnowledgeBaseError, searchKnowledgeBase } from "@/lib/ai/retrieval/search";
import { aiConfigProblem, aiModel, aiProvider } from "@/lib/ai/tutor/provider";
import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

// A development diagnostic for "Ari says there is no study material, but my
// material shows Ready".
//
//   GET /api/knowledge/health           what is indexed, and can it be searched
//   GET /api/knowledge/health?probe=1   also runs one real search per material
//                                       (each costs one embedding request)
//
// It reports on the signed-in user's own materials only, through the same
// Row Level Security as everything else. It never returns a key, only
// whether one is set. It does not exist in production: there it answers 404.
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ authenticated: false, error: "Sign in first, then open this address again." }, { status: 401 });

  const embeddingProvider = embeddingProviderName();
  const embeddingProblem = embeddingConfigProblem();
  const model = embeddingProvider && !embeddingProblem ? embeddingModel(embeddingProvider) : null;
  const aiProblem = aiConfigProblem();
  let ai: { provider: string; model: string } | null = null;
  try {
    ai = { provider: aiProvider(), model: aiModel() };
  } catch {
    // Reported through aiProblem below.
  }

  try {
    const supabase = await createClient();
    const [totals, materials] = await Promise.all([inspectIndex(supabase, user.id, {}, model), reportMaterials(supabase, user.id, model)]);

    const probe = request.nextUrl.searchParams.get("probe") === "1";
    const report = [];
    for (const material of materials.slice(0, 50)) {
      const state = material.indexedChunks === 0 ? "ready but nothing indexed: Reprocess" : material.searchableChunks === 0 ? "indexed with a different embedding model: Reprocess" : "searchable";
      let search: string | undefined;
      if (probe && model && material.indexedChunks > 0) {
        try {
          const found = await searchKnowledgeBase({ query: material.title, materialId: material.id, topK: 3, minScore: 0 });
          search = `${found.length} passage(s) returned`;
        } catch (error) {
          search = `failed: ${error instanceof KnowledgeBaseError ? error.code : "UNKNOWN"}`;
        }
      }
      report.push({ ...material, state, ...(search ? { search } : {}) });
    }

    return NextResponse.json(
      {
        authenticated: true,
        aiProvider: ai?.provider ?? null,
        aiModel: ai?.model ?? null,
        aiConfigured: aiProblem === null,
        // Names of settings only, never their values.
        aiProblem,
        embeddingProvider,
        embeddingModel: model,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        embeddingConfigured: embeddingProblem === null,
        embeddingProblem,
        readyMaterials: totals.readyMaterials,
        chunks: totals.chunks,
        searchableChunks: totals.searchableChunks,
        materials: report,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("[health] check failed", { detail: (error as Error).message });
    return NextResponse.json({ authenticated: true, error: "The knowledge base could not be inspected. See the server log." }, { status: 500 });
  }
}
