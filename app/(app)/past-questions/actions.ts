"use server";

import { revalidatePath } from "next/cache";
import { toResult, type PracticeResult } from "@/lib/ai/practice/errors";
import { getCurrentUser } from "@/lib/auth/dal";
import { MATERIALS_BUCKET, MAX_MATERIAL_FILE_SIZE } from "@/lib/library/config";
import { buildMaterialPath, cleanOriginalFilename, findTypeByExtension, getFileExtension, isSafeStorageName, isUuid, titleFromFilename } from "@/lib/library/files";
import { removeMaterialFiles } from "@/lib/library/storage";
import type { ActionResult } from "@/lib/library/types";
import { parseSetDetails, type SetDetailsInput } from "@/lib/past-questions/details";
import { analyzeSet, type AnalysisResult } from "@/lib/past-questions/process";
import { pastDeps, processingDeps, schedulePastProcessing } from "@/lib/past-questions/queries";
import { createPastSession, type PastSessionInput } from "@/lib/past-questions/sessions";
import { createClient } from "@/lib/supabase/server";

// Thin wrappers around lib/past-questions. The student is always the
// session's user; nothing here accepts a user id, and every row named in a
// request is looked up as that user.

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const NOT_FOUND = "This collection no longer exists.";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const RLS_VIOLATION = "42501";

function revalidatePastQuestions() {
  revalidatePath("/past-questions", "layout");
  revalidatePath("/exam");
  revalidatePath("/dashboard");
}

export type RegisterPastQuestionsInput = SetDetailsInput & {
  setId: string;
  subjectId: string;
  storageName: string;
  originalFilename: string;
};

// Step two of an upload. The browser has already put the file in storage at
// {user}/{subject}/{set}/{storageName}; this records it as a past-question
// collection and starts reading it.
//
// As with study materials, nothing about ownership, size or type is taken
// from the browser: the user comes from the session, the path is rebuilt
// here, and the size and type are read back from storage. If the row cannot
// be created, the file is deleted so it is never left untracked.
export async function registerPastQuestionSet(input: RegisterPastQuestionsInput): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };

  const { setId, subjectId, storageName } = input ?? {};
  if (!isUuid(setId) || !isUuid(subjectId) || !isSafeStorageName(storageName)) {
    return { ok: false, error: "That upload wasn't valid. Please try again." };
  }

  const extension = getFileExtension(storageName);
  const type = findTypeByExtension(extension);
  const filePath = buildMaterialPath(user.id, subjectId, setId, storageName);

  try {
    const supabase = await createClient();
    const discard = () => removeMaterialFiles(supabase, [filePath]);

    // Photos and scans are not accepted here: there is no OCR to read them.
    if (!type || type.kind !== "document") {
      await discard();
      return { ok: false, error: "That file type can't be used for past questions. Upload a PDF, Word, PowerPoint or text file." };
    }

    const originalFilename = cleanOriginalFilename(String(input.originalFilename ?? storageName));
    const details = parseSetDetails(input, titleFromFilename(originalFilename));
    if ("fieldErrors" in details) {
      await discard();
      return { ok: false, error: "Check the highlighted fields.", fieldErrors: details.fieldErrors };
    }

    const { data: info, error: infoError } = await supabase.storage.from(MATERIALS_BUCKET).info(filePath);
    if (infoError || !info) {
      console.error("[past-questions] uploaded file not found", { name: infoError?.name });
      return { ok: false, error: "We couldn't find the uploaded file. Please try again." };
    }
    // The client library has returned this field under both spellings.
    const stored = info as { size?: number; contentType?: string; content_type?: string };
    const size = stored.size ?? 0;
    if (size <= 0 || size > MAX_MATERIAL_FILE_SIZE || (stored.contentType ?? stored.content_type ?? "") !== type.mimeType) {
      await discard();
      return { ok: false, error: "That file isn't a supported type or size, so it was removed." };
    }

    const { error } = await supabase.from("past_question_sets").insert({
      id: setId,
      subject_id: subjectId,
      ...details.values,
      original_filename: originalFilename,
      file_path: filePath,
      mime_type: type.mimeType,
      file_size: size,
      file_extension: extension,
      // user_id and processing_status are set by the database.
    });

    // Already registered (a repeated request): the file belongs to that row.
    if (error?.code === UNIQUE_VIOLATION) return { ok: true, data: { id: setId } };
    if (error) {
      console.error("[past-questions] register failed", { code: error.code });
      await discard();
      if (error.code === FOREIGN_KEY_VIOLATION || error.code === RLS_VIOLATION) {
        return { ok: false, error: "That subject no longer exists, so the file was removed. Choose another subject." };
      }
      return { ok: false, error: "The file uploaded but we couldn't save the collection, so it was removed. Please try again." };
    }

    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session) schedulePastProcessing(setId, user.id, sessionData.session.access_token);

    revalidatePastQuestions();
    return { ok: true, data: { id: setId } };
  } catch {
    console.error("[past-questions] register failed");
    return { ok: false, error: "We couldn't save the collection. Please try again." };
  }
}

// Reads a paper again: used by "Try again" after a failure.
export async function retryPastProcessingAction(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  try {
    const supabase = await createClient();
    const { data: set, error } = await supabase.from("past_question_sets").select("id").eq("user_id", user.id).eq("id", id).maybeSingle();
    if (error) {
      console.error("[past-questions] retry lookup failed", { code: error.code });
      return { ok: false, error: "We couldn't start reading this paper. Please try again." };
    }
    if (!set) return { ok: false, error: NOT_FOUND };

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return { ok: false, error: SESSION_EXPIRED };
    schedulePastProcessing(id, user.id, sessionData.session.access_token);
    return { ok: true };
  } catch {
    console.error("[past-questions] retry failed");
    return { ok: false, error: "We couldn't start reading this paper. Please try again." };
  }
}

// Asks Ari to label the questions that have no topic yet. Waits for it.
export async function analyzePastSetAction(id: string): Promise<ActionResult<AnalysisResult>> {
  const deps = await processingDeps();
  if (!deps) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  try {
    // A collection that is not the caller's is not found by their store.
    if (!(await deps.store.getSet(id))) return { ok: false, error: NOT_FOUND };
    const result = await analyzeSet(id, deps);
    revalidatePastQuestions();
    if (result.reason === "not_configured") return { ok: false, error: "Ari isn't set up to analyse questions yet. Your questions are saved and can still be browsed." };
    if (result.reason === "unavailable" && result.analyzed === 0) return { ok: false, error: "Ari's AI service is unavailable right now, so the topics couldn't be worked out. Please try again later." };
    return { ok: true, data: result };
  } catch (error) {
    console.error("[past-questions] analysis failed", { detail: (error as Error).message });
    return { ok: false, error: "We couldn't analyse these questions just now. Please try again." };
  }
}

// File first, then the row. If the file cannot be removed the row is kept,
// so the delete can be retried. Practice sessions and exams already taken
// from the collection are kept; they hold their own copies of the questions.
export async function deletePastQuestionSet(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: SESSION_EXPIRED };
  if (!isUuid(id)) return { ok: false, error: NOT_FOUND };

  const failed = "We couldn't delete this collection. Please try again.";
  try {
    const supabase = await createClient();
    const { data: set, error: lookupError } = await supabase.from("past_question_sets").select("id, file_path").eq("user_id", user.id).eq("id", id).maybeSingle();
    if (lookupError) {
      console.error("[past-questions] delete lookup failed", { code: lookupError.code });
      return { ok: false, error: failed };
    }
    if (!set) return { ok: false, error: NOT_FOUND };

    if (!(await removeMaterialFiles(supabase, [set.file_path]))) return { ok: false, error: failed };
    const { error } = await supabase.from("past_question_sets").delete().eq("user_id", user.id).eq("id", id);
    if (error) {
      console.error("[past-questions] delete failed", { code: error.code });
      return { ok: false, error: failed };
    }

    revalidatePastQuestions();
    return { ok: true };
  } catch {
    console.error("[past-questions] delete failed");
    return { ok: false, error: failed };
  }
}

// Starts a practice session from past questions. It is stored as a quiz and
// taken with the ordinary quiz runner at /quizzes/<id>.
export async function startPastPracticeAction(input: Omit<PastSessionInput, "kind" | "timeLimitMinutes">): Promise<PracticeResult<{ quizId: string; delivered: number; requested: number | null }>> {
  return toResult("past practice", async () => {
    const { quiz, delivered, requested } = await createPastSession({ ...input, kind: "practice" }, pastDeps());
    return { quizId: quiz.id, delivered, requested };
  });
}
