import { ProcessingError, toProcessingError, type ProcessingErrorCode } from "@/lib/ai/errors";
import { PracticeError } from "@/lib/ai/practice/errors";
import { TutorError } from "@/lib/ai/tutor/errors";
import type { ModelOptions, TutorModel } from "@/lib/ai/tutor/provider";
import { analyzeBatch } from "./analysis";
import { PAST } from "./config";
import { parsePastQuestions } from "./parser";
import { readPaper } from "./read";
import type { PastProcessingStore } from "./store";
import type { AnalysisStatus } from "./types";

// Turns an uploaded paper into stored questions:
//
//   claim → download → extract text → read questions → store → ready
//                                                        └→ label topics (AI, optional)
//
// Reading the questions needs no AI model and no embedding provider, so a
// paper is usable even when neither is configured. Topic labelling runs
// afterwards and can only add to what was read: if it fails, the paper stays
// ready and its questions stay unlabelled.

export type PastProcessingDeps = {
  store: PastProcessingStore;
  // The tutor's chat model. Throws TutorError("NOT_CONFIGURED") without a key.
  getModel(options?: ModelOptions): TutorModel;
  now?: () => number;
};

// What the student is told when a paper cannot be read. Never a stack trace,
// a provider response or a path.
const FAILURE_MESSAGES: Partial<Record<ProcessingErrorCode, string>> = {
  EXTRACTION_FAILED: "We couldn't read this file. It may be damaged or password-protected.",
  OCR_UNAVAILABLE: "This file is a scan or a photo rather than text. Reading scanned papers isn't available yet, so no questions could be read from it.",
  EMPTY_DOCUMENT: "No readable text was found in this file, so there were no questions to read.",
  DOWNLOAD_FAILED: "We couldn't open the uploaded file. Please try again.",
  PROCESSING_TIMEOUT: "This paper took too long to read. Try splitting it into smaller files.",
  UNSUPPORTED_FILE: "This file type can't be read for past questions.",
};
const UNKNOWN_FAILURE = "Something went wrong while reading this paper. Please try again.";

export type PastProcessingResult =
  | { status: "ready"; structured: number; raw: number; withAnswers: number; analysis: AnalysisStatus }
  | { status: "failed"; code: ProcessingErrorCode }
  // Nothing was done: not found, not owned, or already being processed.
  | { status: "skipped" };

export type AnalysisResult = { status: AnalysisStatus; analyzed: number; remaining: number; reason?: "not_configured" | "unavailable" };

// Labels the questions of one collection that have no topic yet. Bounded:
// at most PAST.analysisMaxCalls model calls per run. Safe to run again; it
// only ever looks at questions it has not labelled.
export async function analyzeSet(setId: string, { store, getModel }: PastProcessingDeps): Promise<AnalysisResult> {
  const set = await store.getSet(setId);
  if (!set) return { status: "pending", analyzed: 0, remaining: 0 };

  const pending = await store.listUnanalyzed(setId, PAST.maxQuestionsPerSet);
  if (pending.length === 0) {
    await store.setAnalysisStatus(setId, "complete");
    return { status: "complete", analyzed: 0, remaining: 0 };
  }

  let model: TutorModel;
  try {
    model = getModel({ maxOutputTokens: PAST.analysisMaxOutputTokens, effort: PAST.analysisEffort, json: true });
  } catch (error) {
    if (!(error instanceof TutorError)) throw error;
    return { status: set.analysisStatus, analyzed: 0, remaining: pending.length, reason: "not_configured" };
  }

  const subject = await store.getSubject(set.subjectId);
  const knownTopics = await store.knownTopics(set.subjectId);
  let analyzed = 0;
  let reason: AnalysisResult["reason"];

  for (let call = 0; call < PAST.analysisMaxCalls && call * PAST.analysisBatchSize < pending.length; call++) {
    const batch = pending.slice(call * PAST.analysisBatchSize, (call + 1) * PAST.analysisBatchSize);
    try {
      const updates = await analyzeBatch(model, batch, { subjectName: subject?.name ?? "General", knownTopics });
      await store.applyAnalysis(updates);
      analyzed += updates.length;
      for (const update of updates) if (!knownTopics.includes(update.topic)) knownTopics.push(update.topic);
    } catch (error) {
      // The provider is busy, out of quota or down. Keep what was labelled
      // and stop; the rest can be done later.
      if (!(error instanceof PracticeError)) throw error;
      console.error("[past-questions] analysis stopped", { setId, code: error.code, detail: error.detail });
      reason = "unavailable";
      break;
    }
  }

  const remaining = pending.length - analyzed;
  const status: AnalysisStatus = remaining === 0 ? "complete" : analyzed > 0 || set.analysisStatus === "partial" ? "partial" : "pending";
  await store.setAnalysisStatus(setId, status);
  return { status, analyzed, remaining, reason };
}

export async function processPastQuestionSet(setId: string, deps: PastProcessingDeps): Promise<PastProcessingResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  const paper = await store.claim(setId);
  if (!paper) return { status: "skipped" };
  const deadline = now() + PAST.processingTimeoutMs;

  let parsed;
  try {
    let bytes: Uint8Array;
    try {
      bytes = await store.download(paper);
    } catch (error) {
      throw toProcessingError(error, "DOWNLOAD_FAILED");
    }

    const { document, numbersPrinted } = await readPaper({ bytes, typeId: paper.typeId, mimeType: paper.mimeType });
    if (now() > deadline) throw new ProcessingError("PROCESSING_TIMEOUT");

    parsed = parsePastQuestions(document, { year: paper.year, trustNumbers: numbersPrinted });
    if (parsed.questions.length === 0) throw new ProcessingError("EMPTY_DOCUMENT");

    await store.replaceQuestions(setId, parsed.questions);
    await store.finish(setId);
  } catch (error) {
    const failure = toProcessingError(error);
    // The detail is for operators; only the safe message is stored.
    console.error("[past-questions] processing failed", { setId, code: failure.code, detail: failure.detail });
    try {
      await store.fail(setId, FAILURE_MESSAGES[failure.code] ?? UNKNOWN_FAILURE);
    } catch (storeError) {
      console.error("[past-questions] could not record failure", { setId, detail: (storeError as Error).message });
    }
    return { status: "failed", code: failure.code };
  }

  let analysis: AnalysisStatus = "pending";
  if (parsed.structured > 0) {
    try {
      analysis = (await analyzeSet(setId, deps)).status;
    } catch (error) {
      console.error("[past-questions] analysis failed", { setId, detail: (error as Error).message });
    }
  }
  return { status: "ready", structured: parsed.structured, raw: parsed.raw, withAnswers: parsed.withAnswers, analysis };
}
