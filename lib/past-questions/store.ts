import type { SupabaseClient } from "@supabase/supabase-js";
import { ANSWER_COLUMNS, ATTEMPT_COLUMNS, QUESTION_COLUMNS, QUIZ_COLUMNS, toAnswer, toAttempt, toQuestion, toQuiz } from "@/lib/ai/practice/store";
import type { AnswerResult, Difficulty, DifficultyChoice, QuestionType, Quiz, QuizAnswer, QuizQuestion } from "@/lib/ai/practice/types";
import { MATERIALS_BUCKET } from "@/lib/library/config";
import type { AnalysisUpdate } from "./analysis";
import { PAST } from "./config";
import type { AnalysisStatus, AnswerSource, ExamAttempt, ExamState, KnownAnswerSource, ParsedQuestion, PastQuestion, PastQuestionSet, PastQuestionType, SetStatus } from "./types";

// Where past questions, practice sessions and exams are kept. The flows in
// this folder depend on these interfaces only, so they can be tested with an
// in-memory stand-in.
//
// A store always acts for ONE signed-in user. Whatever the backend, it must
// behave as if other users' rows do not exist: lookups return null and
// writes are refused. The caller never passes a user id to choose whose data
// to use.

// A copy of a past question inside a practice session or an exam.
export type SessionQuestion = QuizQuestion & {
  pastQuestionId: string | null;
  // As printed in the paper ("14", "1a").
  number: string | null;
  explanationSource: KnownAnswerSource | null;
  // Ari's estimate, or null when the question has none. (`difficulty` on a
  // quiz question falls back to "medium", which would be a claim here.)
  estimatedDifficulty: Difficulty | null;
};

export type NewSession = {
  title: string;
  mode: "past_practice" | "exam";
  subjectId: string | null;
  // The one collection every question came from, if there is just one.
  setId: string | null;
  difficulty: DifficultyChoice;
  questions: (PastQuestion & { setTitle: string; subjectName: string })[];
};

export interface PastStore {
  // Null for an unknown id and for another user's row alike, in every lookup.
  getSubject(id: string): Promise<{ id: string; name: string } | null>;
  listSets(): Promise<PastQuestionSet[]>;
  // Every question of the given collections, in document order.
  listQuestions(setIds: string[]): Promise<PastQuestion[]>;
  // How the student did the last time they answered each past question.
  getHistory(): Promise<Map<string, AnswerResult>>;
  countAttemptsSince(since: Date): Promise<number>;

  createSession(input: NewSession): Promise<Quiz>;
  createAttempt(quizId: string, totalQuestions: number, timeLimitSeconds: number | null): Promise<ExamAttempt>;
  getQuiz(id: string): Promise<Quiz | null>;
  getAttempt(id: string): Promise<ExamAttempt | null>;
  getQuestions(quizId: string): Promise<SessionQuestion[]>;
  getAnswers(attemptId: string): Promise<QuizAnswer[]>;
  // False when the exam is finished or out of time.
  saveProgress(attemptId: string, state: ExamState): Promise<boolean>;
  // Marks the exam from the student's choices and closes it. The marking is
  // done by the store, never taken from the caller.
  submitExam(attemptId: string, state: ExamState): Promise<ExamAttempt | null>;
}

export type PaperToProcess = { id: string; subjectId: string; filePath: string; mimeType: string; typeId: string; year: number | null };

export interface PastProcessingStore {
  // Marks the collection 'processing'. Null when it does not exist, belongs
  // to someone else, or is already being processed.
  claim(setId: string): Promise<PaperToProcess | null>;
  download(paper: PaperToProcess): Promise<Uint8Array>;
  // Replaces whatever was read from the paper before.
  replaceQuestions(setId: string, questions: ParsedQuestion[]): Promise<void>;
  finish(setId: string): Promise<void>;
  fail(setId: string, message: string): Promise<void>;

  getSet(id: string): Promise<PastQuestionSet | null>;
  getSubject(id: string): Promise<{ id: string; name: string } | null>;
  // Topic names this student already has in a subject.
  knownTopics(subjectId: string): Promise<string[]>;
  listUnanalyzed(setId: string, limit: number): Promise<PastQuestion[]>;
  applyAnalysis(updates: AnalysisUpdate[]): Promise<void>;
  setAnalysisStatus(setId: string, status: AnalysisStatus): Promise<void>;
}

// ------------------------------------------------------------- row mapping

export const SET_COLUMNS =
  "id, subject_id, title, exam_type, institution, exam_year, course_code, description, original_filename, file_extension, processing_status, processing_error, processing_started_at, analysis_status, created_at";
export const PAST_QUESTION_COLUMNS =
  "id, set_id, position, question_number, question, question_type, options, correct_answer, answer_source, explanation, explanation_source, exam_year, topic, difficulty, analyzed_at, page_number, slide_number";
export const EXAM_ATTEMPT_COLUMNS = `${ATTEMPT_COLUMNS}, time_limit_seconds, time_used_seconds, exam_state`;
const SESSION_QUESTION_COLUMNS = `${QUESTION_COLUMNS}, past_question_id`;

type Row = Record<string, unknown>;

export function toSet(row: Row): PastQuestionSet {
  return {
    id: row.id as string,
    subjectId: row.subject_id as string,
    title: row.title as string,
    examType: (row.exam_type as string | null) ?? null,
    institution: (row.institution as string | null) ?? null,
    year: (row.exam_year as number | null) ?? null,
    courseCode: (row.course_code as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    originalFilename: row.original_filename as string,
    fileExtension: row.file_extension as string,
    status: row.processing_status as SetStatus,
    error: (row.processing_error as string | null) ?? null,
    processingStartedAt: (row.processing_started_at as string | null) ?? null,
    analysisStatus: row.analysis_status as AnalysisStatus,
    createdAt: row.created_at as string,
  };
}

export function toPastQuestion(row: Row): PastQuestion {
  return {
    id: row.id as string,
    setId: row.set_id as string,
    position: row.position as number,
    number: (row.question_number as string | null) ?? null,
    type: row.question_type as PastQuestionType,
    question: row.question as string,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    correctAnswer: (row.correct_answer as string | boolean | null) ?? null,
    answerSource: row.answer_source as AnswerSource,
    explanation: (row.explanation as string | null) ?? null,
    explanationSource: (row.explanation_source as KnownAnswerSource | null) ?? null,
    year: (row.exam_year as number | null) ?? null,
    topic: (row.topic as string | null) ?? null,
    difficulty: (row.difficulty as Difficulty | null) ?? null,
    analyzed: Boolean(row.analyzed_at),
    page: (row.page_number as number | null) ?? null,
    slide: (row.slide_number as number | null) ?? null,
  };
}

export function toExamState(value: unknown): ExamState {
  const state = (value ?? {}) as { answers?: unknown; flagged?: unknown; late?: unknown };
  const answers: ExamState["answers"] = {};
  if (state.answers && typeof state.answers === "object" && !Array.isArray(state.answers)) {
    for (const [id, answer] of Object.entries(state.answers)) {
      if (typeof answer === "number" || typeof answer === "boolean") answers[id] = answer;
    }
  }
  return {
    answers,
    flagged: Array.isArray(state.flagged) ? state.flagged.filter((id): id is string => typeof id === "string") : [],
    late: state.late === true,
  };
}

export function toExamAttempt(row: Row): ExamAttempt {
  return {
    ...toAttempt(row),
    timeLimitSeconds: (row.time_limit_seconds as number | null) ?? null,
    timeUsedSeconds: (row.time_used_seconds as number | null) ?? null,
    state: toExamState(row.exam_state),
  };
}

export function toSessionQuestion(row: Row): SessionQuestion {
  const metadata = (row.metadata ?? {}) as { number?: string | null; explanationSource?: KnownAnswerSource | null; difficulty?: Difficulty };
  return {
    ...toQuestion(row),
    pastQuestionId: (row.past_question_id as string | null) ?? null,
    number: metadata.number ?? null,
    explanationSource: metadata.explanationSource ?? null,
    estimatedDifficulty: metadata.difficulty ?? null,
  };
}

// Shown where a paper gave an answer but no reason for it.
export const NO_EXPLANATION = "The uploaded paper gives no explanation for this answer. Ask Ari to explain it.";

// Past questions, sessions and exams in the app's own Supabase database,
// reached with the signed-in user's own client. Row Level Security is what
// limits every query to that user; the user_id filters state the intent and
// let Postgres use its indexes. user_id is never written: the database fills
// it in from the session, and clients have no privilege to set it.
export class SupabasePastStore implements PastStore, PastProcessingStore {
  private readonly supabase: SupabaseClient;
  private readonly userId: string;

  constructor(supabase: SupabaseClient, userId: string) {
    this.supabase = supabase;
    this.userId = userId;
  }

  private async one(table: string, columns: string, id: string) {
    const { data, error } = await this.supabase.from(table).select(columns).eq("user_id", this.userId).eq("id", id).maybeSingle();
    if (error) throw new Error(`${table} select: ${error.code}`);
    return data as unknown as Row | null;
  }

  async getSubject(id: string) {
    return (await this.one("subjects", "id, name", id)) as { id: string; name: string } | null;
  }

  async getSet(id: string) {
    const row = await this.one("past_question_sets", SET_COLUMNS, id);
    return row && toSet(row);
  }

  async listSets() {
    const { data, error } = await this.supabase.from("past_question_sets").select(SET_COLUMNS).eq("user_id", this.userId).order("created_at", { ascending: false });
    if (error) throw new Error(`past_question_sets select: ${error.code}`);
    return (data as Row[]).map(toSet);
  }

  async listQuestions(setIds: string[]) {
    if (setIds.length === 0) return [];
    const { data, error } = await this.supabase
      .from("past_questions")
      .select(PAST_QUESTION_COLUMNS)
      .eq("user_id", this.userId)
      .in("set_id", setIds)
      .order("set_id")
      .order("position")
      .limit(PAST.maxListedQuestions);
    if (error) throw new Error(`past_questions select: ${error.code}`);
    return (data as Row[]).map(toPastQuestion);
  }

  async getHistory() {
    const [copies, answers] = await Promise.all([
      this.supabase.from("quiz_questions").select("id, past_question_id").eq("user_id", this.userId).not("past_question_id", "is", null).limit(20_000),
      this.supabase.from("quiz_answers").select("question_id, result, answered_at").eq("user_id", this.userId).order("answered_at", { ascending: false }).limit(10_000),
    ]);
    const failed = copies.error ?? answers.error;
    if (failed) throw new Error(`history select: ${failed.code}`);

    const source = new Map((copies.data as { id: string; past_question_id: string }[]).map((row) => [row.id, row.past_question_id]));
    const history = new Map<string, AnswerResult>();
    // Newest first, so the first answer seen for a question is its latest.
    for (const answer of answers.data as { question_id: string; result: AnswerResult }[]) {
      const pastQuestionId = source.get(answer.question_id);
      if (pastQuestionId && !history.has(pastQuestionId)) history.set(pastQuestionId, answer.result);
    }
    return history;
  }

  async countAttemptsSince(since: Date) {
    const { count, error } = await this.supabase
      .from("quiz_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", this.userId)
      .gte("started_at", since.toISOString());
    if (error) throw new Error(`quiz_attempts count: ${error.code}`);
    return count ?? 0;
  }

  async createSession({ title, mode, subjectId, setId, difficulty, questions }: NewSession) {
    const types = [...new Set(questions.map((question) => question.type))] as QuestionType[];
    const { data, error } = await this.supabase
      .from("quizzes")
      .insert({ title, mode, subject_id: subjectId, past_question_set_id: setId, difficulty, question_count: questions.length, question_types: types })
      .select(QUIZ_COLUMNS)
      .single();
    if (error) throw new Error(`quizzes insert: ${error.code}`);
    const quiz = toQuiz(data as Row);

    const { error: questionsError } = await this.supabase.from("quiz_questions").insert(
      questions.map((question, position) => ({
        quiz_id: quiz.id,
        past_question_id: question.id,
        position,
        question: question.question,
        question_type: question.type,
        options: question.options,
        correct_answer: question.correctAnswer,
        explanation: question.explanation ?? NO_EXPLANATION,
        sources: [{ n: 1, materialId: question.setId, title: question.setTitle, subject: question.subjectName, page: question.page, slide: question.slide, section: null }],
        metadata: {
          topic: question.topic ?? "",
          // Left out when there is no estimate, so none is ever implied.
          ...(question.difficulty ? { difficulty: question.difficulty } : {}),
          answerSource: question.answerSource,
          explanationSource: question.explanation ? question.explanationSource : null,
          number: question.number,
          year: question.year,
          acceptablePoints: [],
          sourceExcerpt: "",
        },
      })),
    );
    if (questionsError) {
      // A session with no questions is useless: take it back out.
      await this.supabase.from("quizzes").delete().eq("user_id", this.userId).eq("id", quiz.id);
      throw new Error(`quiz_questions insert: ${questionsError.code}`);
    }
    return quiz;
  }

  async createAttempt(quizId: string, totalQuestions: number, timeLimitSeconds: number | null) {
    const { data, error } = await this.supabase
      .from("quiz_attempts")
      .insert({ quiz_id: quizId, total_questions: totalQuestions, time_limit_seconds: timeLimitSeconds })
      .select(EXAM_ATTEMPT_COLUMNS)
      .single();
    if (error) throw new Error(`quiz_attempts insert: ${error.code}`);
    return toExamAttempt(data as unknown as Row);
  }

  async getQuiz(id: string) {
    const row = await this.one("quizzes", QUIZ_COLUMNS, id);
    return row && toQuiz(row);
  }

  async getAttempt(id: string) {
    const row = await this.one("quiz_attempts", EXAM_ATTEMPT_COLUMNS, id);
    return row && toExamAttempt(row);
  }

  async getQuestions(quizId: string) {
    const { data, error } = await this.supabase.from("quiz_questions").select(SESSION_QUESTION_COLUMNS).eq("user_id", this.userId).eq("quiz_id", quizId).order("position");
    if (error) throw new Error(`quiz_questions select: ${error.code}`);
    return (data as unknown as Row[]).map(toSessionQuestion);
  }

  async getAnswers(attemptId: string) {
    const { data, error } = await this.supabase.from("quiz_answers").select(ANSWER_COLUMNS).eq("user_id", this.userId).eq("attempt_id", attemptId);
    if (error) throw new Error(`quiz_answers select: ${error.code}`);
    return (data as Row[]).map(toAnswer);
  }

  async saveProgress(attemptId: string, state: ExamState) {
    const { data, error } = await this.supabase.rpc("save_exam_progress", { p_attempt_id: attemptId, p_answers: state.answers, p_flagged: state.flagged });
    if (error) throw new Error(`save_exam_progress: ${error.code}`);
    return data === true;
  }

  async submitExam(attemptId: string, state: ExamState) {
    const { data, error } = await this.supabase.rpc("submit_exam_attempt", { p_attempt_id: attemptId, p_answers: state.answers, p_flagged: state.flagged });
    if (error) throw new Error(`submit_exam_attempt: ${error.code}`);
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    return row?.id ? toExamAttempt(row) : null;
  }

  // -------------------------------------------------------------- processing

  async claim(setId: string) {
    const now = new Date();
    const stale = new Date(now.getTime() - PAST.staleProcessingMinutes * 60_000).toISOString();
    // One conditional update, so two requests cannot both claim the paper.
    const { data, error } = await this.supabase
      .from("past_question_sets")
      .update({ processing_status: "processing", processing_error: null, processing_started_at: now.toISOString() })
      .eq("user_id", this.userId)
      .eq("id", setId)
      .or(`processing_status.neq.processing,processing_started_at.is.null,processing_started_at.lt.${stale}`)
      .select("id, subject_id, file_path, mime_type, file_extension, exam_year")
      .maybeSingle();
    if (error) throw new Error(`past_question_sets claim: ${error.code}`);
    if (!data) return null;
    return {
      id: data.id as string,
      subjectId: data.subject_id as string,
      filePath: data.file_path as string,
      mimeType: data.mime_type as string,
      typeId: data.file_extension === "jpeg" ? "jpg" : (data.file_extension as string),
      year: (data.exam_year as number | null) ?? null,
    };
  }

  async download(paper: PaperToProcess) {
    // The bucket is private; this succeeds only for the owner's own path.
    const { data, error } = await this.supabase.storage.from(MATERIALS_BUCKET).download(paper.filePath);
    if (error || !data) throw new Error(`download: ${error?.message ?? "no data"}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async replaceQuestions(setId: string, questions: ParsedQuestion[]) {
    const { error: deleteError } = await this.supabase.from("past_questions").delete().eq("user_id", this.userId).eq("set_id", setId);
    if (deleteError) throw new Error(`past_questions delete: ${deleteError.code}`);

    const rows = questions.map((question, position) => ({
      set_id: setId,
      position,
      question_number: question.number?.slice(0, 12) ?? null,
      question: question.question,
      question_type: question.type,
      options: question.options,
      correct_answer: question.correctAnswer,
      answer_source: question.correctAnswer === null ? "answer_unavailable" : "official",
      explanation: question.explanation,
      explanation_source: question.explanation ? "official" : null,
      exam_year: question.year,
      page_number: question.page,
      slide_number: question.slide,
    }));
    for (let start = 0; start < rows.length; start += 200) {
      const { error } = await this.supabase.from("past_questions").insert(rows.slice(start, start + 200));
      if (error) throw new Error(`past_questions insert: ${error.code}`);
    }
  }

  private async updateSet(setId: string, values: Row) {
    const { error } = await this.supabase.from("past_question_sets").update(values).eq("user_id", this.userId).eq("id", setId);
    if (error) throw new Error(`past_question_sets update: ${error.code}`);
  }

  async finish(setId: string) {
    await this.updateSet(setId, { processing_status: "ready", processing_error: null, processed_at: new Date().toISOString(), analysis_status: "pending" });
  }

  async fail(setId: string, message: string) {
    await this.updateSet(setId, { processing_status: "failed", processing_error: message.slice(0, 500) });
  }

  async setAnalysisStatus(setId: string, status: AnalysisStatus) {
    await this.updateSet(setId, { analysis_status: status });
  }

  async knownTopics(subjectId: string) {
    const [sets, quizzes] = await Promise.all([
      this.supabase.from("past_question_sets").select("id").eq("user_id", this.userId).eq("subject_id", subjectId),
      this.supabase.from("quizzes").select("id").eq("user_id", this.userId).eq("subject_id", subjectId).order("created_at", { ascending: false }).limit(100),
    ]);
    const failed = sets.error ?? quizzes.error;
    if (failed) throw new Error(`topics select: ${failed.code}`);

    const setIds = (sets.data as { id: string }[]).map((row) => row.id);
    const quizIds = (quizzes.data as { id: string }[]).map((row) => row.id);
    const [past, generated] = await Promise.all([
      setIds.length ? this.supabase.from("past_questions").select("topic").eq("user_id", this.userId).in("set_id", setIds).not("topic", "is", null).limit(5000) : { data: [], error: null },
      quizIds.length ? this.supabase.from("quiz_questions").select("topic:metadata->>topic").eq("user_id", this.userId).in("quiz_id", quizIds).limit(5000) : { data: [], error: null },
    ]);
    const failedTopics = past.error ?? generated.error;
    if (failedTopics) throw new Error(`topics select: ${failedTopics.code}`);

    const counts = new Map<string, number>();
    for (const row of [...(past.data as { topic: string | null }[]), ...(generated.data as unknown as { topic: string | null }[])]) {
      const topic = row.topic?.trim();
      if (topic && topic !== "Uncategorized") counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic]) => topic).slice(0, PAST.maxKnownTopics);
  }

  async listUnanalyzed(setId: string, limit: number) {
    const { data, error } = await this.supabase
      .from("past_questions")
      .select(PAST_QUESTION_COLUMNS)
      .eq("user_id", this.userId)
      .eq("set_id", setId)
      .neq("question_type", "raw")
      .is("analyzed_at", null)
      .order("position")
      .limit(limit);
    if (error) throw new Error(`past_questions select: ${error.code}`);
    return (data as Row[]).map(toPastQuestion);
  }

  async applyAnalysis(updates: AnalysisUpdate[]) {
    const analyzedAt = new Date().toISOString();
    // Questions given the same label are updated together.
    const groups = new Map<string, AnalysisUpdate[]>();
    for (const update of updates.filter((item) => item.answer === undefined)) {
      const key = `${update.topic}|${update.difficulty ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), update]);
    }
    for (const group of groups.values()) {
      const { error } = await this.supabase
        .from("past_questions")
        .update({ topic: group[0].topic, difficulty: group[0].difficulty, analyzed_at: analyzedAt })
        .eq("user_id", this.userId)
        .in("id", group.map((update) => update.id));
      if (error) throw new Error(`past_questions update: ${error.code}`);
    }

    for (const update of updates.filter((item) => item.answer !== undefined)) {
      const { error } = await this.supabase
        .from("past_questions")
        .update({
          topic: update.topic,
          difficulty: update.difficulty,
          analyzed_at: analyzedAt,
          correct_answer: update.answer,
          answer_source: "ai_generated",
          ...(update.explanation ? { explanation: update.explanation, explanation_source: "ai_generated" } : {}),
        })
        .eq("user_id", this.userId)
        .eq("id", update.id)
        // Only ever where the paper gave no answer of its own.
        .eq("answer_source", "answer_unavailable");
      if (error) throw new Error(`past_questions update: ${error.code}`);
    }
  }
}
