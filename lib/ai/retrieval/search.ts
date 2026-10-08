import "server-only";

import { getCurrentUser } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";
import { getEmbeddingProvider, type EmbeddingProvider } from "../embeddings/provider";
import { KnowledgeBaseError, searchWith, type KnowledgeBaseQuery } from "./query";
import { SupabaseVectorRepository, type RetrievedChunk } from "./repository";

export { KnowledgeBaseError, type KnowledgeBaseQuery, type RetrievedChunk };

// Finds the passages in the signed-in user's study materials that are most
// relevant to a question. This is the entry point the tutor will use:
//
//   const chunks = await searchKnowledgeBase({ query, subjectId });
//
// The user is never an argument. They are taken from the session, and the
// database restricts results to them again on its own.
export async function searchKnowledgeBase(query: KnowledgeBaseQuery): Promise<RetrievedChunk[]> {
  const user = await getCurrentUser();
  if (!user) throw new KnowledgeBaseError("UNAUTHENTICATED", "Sign in to search your materials.");

  let embeddings: EmbeddingProvider;
  try {
    embeddings = getEmbeddingProvider();
  } catch {
    throw new KnowledgeBaseError("NOT_CONFIGURED", "Ari's knowledge base isn't set up yet.");
  }

  try {
    return await searchWith(query, embeddings, new SupabaseVectorRepository(await createClient()));
  } catch (error) {
    if (error instanceof KnowledgeBaseError) throw error;
    console.error("[retrieval] search failed", { detail: (error as Error).message });
    throw new KnowledgeBaseError("SEARCH_FAILED", "We couldn't search your materials. Please try again.");
  }
}
