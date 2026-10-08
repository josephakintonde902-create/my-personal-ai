import { NextResponse, type NextRequest } from "next/server";
import { KnowledgeBaseError, searchKnowledgeBase } from "@/lib/ai/retrieval/search";
import { getCurrentUser } from "@/lib/auth/dal";
import { readJsonObject } from "@/lib/http/body";

const STATUS: Record<KnowledgeBaseError["code"], number> = {
  UNAUTHENTICATED: 401,
  INVALID_QUERY: 400,
  NOT_CONFIGURED: 503,
  SEARCH_FAILED: 500,
};

// Searches the signed-in user's own study materials.
//
//   POST /api/knowledge/search
//   { "query": "what is refraction?", "subjectId"?: "...", "materialId"?: "...", "topK"?: 5 }
//
// There is no user parameter: results always belong to the session's user.
// This is a thin wrapper around searchKnowledgeBase(), which is what
// server-side features (the tutor, quizzes) call directly.
export async function POST(request: NextRequest) {
  // Who is asking comes first: a signed-out request is refused before its
  // body is read. searchKnowledgeBase() checks again on its own.
  if (!(await getCurrentUser())) {
    return NextResponse.json({ error: "Sign in to search your materials.", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await readJsonObject(request);
  if (!body.ok) {
    return body.reason === "too_large"
      ? NextResponse.json({ error: "That request is too large." }, { status: 413 })
      : NextResponse.json({ error: "Send a JSON body with a \"query\"." }, { status: 400 });
  }
  const input = body.value;

  try {
    const results = await searchKnowledgeBase({
      query: input.query as string,
      subjectId: typeof input.subjectId === "string" ? input.subjectId : undefined,
      materialId: typeof input.materialId === "string" ? input.materialId : undefined,
      topK: typeof input.topK === "number" ? input.topK : undefined,
      minScore: typeof input.minScore === "number" ? input.minScore : undefined,
    });
    return NextResponse.json({ results }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof KnowledgeBaseError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
    }
    console.error("[api] knowledge search failed");
    return NextResponse.json({ error: "We couldn't search your materials." }, { status: 500 });
  }
}
