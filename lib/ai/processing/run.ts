import "server-only";

import { after } from "next/server";
import { createUserClient } from "@/lib/supabase/user-client";
import { getOcrProvider } from "../documents/ocr";
import { getEmbeddingProvider, isEmbeddingConfigured } from "../embeddings/provider";
import { processMaterial } from "./pipeline";
import { SupabaseProcessingStore } from "./supabase-store";

// Processing needs an embedding provider. Without one, materials are left as
// 'pending' rather than being marked as failed for a reason the student
// cannot do anything about.
export function isProcessingConfigured() {
  return isEmbeddingConfigured();
}

// Runs the pipeline for one material as the given user and waits for it.
export async function runMaterialProcessing(materialId: string, accessToken: string) {
  return processMaterial(materialId, {
    store: new SupabaseProcessingStore(createUserClient(accessToken)),
    embeddings: getEmbeddingProvider(),
    ocr: getOcrProvider(),
  });
}

// Starts processing on the server after the current response has been sent.
// The browser is not involved: it can navigate away or close and the work
// continues, for as long as the hosting platform lets the request live
// (`maxDuration` on the pages that upload). If the server is stopped midway,
// the material stays 'processing' and can be retried once the attempt is
// considered stale.
export function scheduleMaterialProcessing(materialId: string, accessToken: string) {
  if (!isProcessingConfigured()) return false;

  after(async () => {
    try {
      await runMaterialProcessing(materialId, accessToken);
    } catch (error) {
      console.error("[processing] run crashed", { materialId, detail: (error as Error).message });
    }
  });
  return true;
}
