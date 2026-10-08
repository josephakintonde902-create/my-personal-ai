import { embeddingConfigProblem } from "@/lib/ai/embeddings/provider";
import { aiConfigProblem } from "@/lib/ai/tutor/provider";
import { checkSupabase } from "@/lib/supabase/health";

export const dynamic = "force-dynamic";

// Whether this deployment is set up to work.
//
//   GET /api/health
//
// Open it on a new deployment before anything else. It needs no sign-in,
// because the thing it most needs to report is sign-in being broken. For that
// reason it says little: for Supabase, which setting is wrong (both settings
// are public); for AI, only whether it is configured. The reason is in the
// server log. It never returns a value, and it does not call an AI provider.
export async function GET() {
  const supabase = await checkSupabase({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  });
  const aiProblem = aiConfigProblem();
  const embeddingProblem = embeddingConfigProblem();

  const ok = supabase.status === "ok" && !aiProblem && !embeddingProblem;
  if (!ok) console.error("[health] deployment is not set up correctly", { supabase: supabase.status, detail: supabase.detail, aiProblem, embeddingProblem });

  return Response.json(
    { ok, supabase, ai: { configured: !aiProblem }, embeddings: { configured: !embeddingProblem } },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
