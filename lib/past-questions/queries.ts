import "server-only";

import { after } from "next/server";
import { answerText } from "@/lib/ai/practice/explain";
import { QUIZ_COLUMNS, toQuiz } from "@/lib/ai/practice/store";
import type { AnswerResult, Difficulty, Quiz } from "@/lib/ai/practice/types";
import { TUTOR } from "@/lib/ai/tutor/config";
import { getTutorModel } from "@/lib/ai/tutor/provider";
import { getCurrentUser } from "@/lib/auth/dal";
import { isUuid } from "@/lib/library/files";
import { getSubjects } from "@/lib/library/queries";
import type { SubjectOption } from "@/lib/library/types";
import { getPerformance } from "@/lib/performance/queries";
import { createClient } from "@/lib/supabase/server";
import { createUserClient } from "@/lib/supabase/user-client";
import { topicFrequency } from "./analysis";
import { PAST, UNCATEGORIZED } from "./config";
import { processPastQuestionSet, type PastProcessingDeps } from "./process";
import { reviewExam, secondsRemaining, toExamQuestion, type ExamQuestion, type ExamReview, type PastDeps } from "./sessions";
import { EXAM_ATTEMPT_COLUMNS, PAST_QUESTION_COLUMNS, SET_COLUMNS, SupabasePastStore, toExamAttempt, toPastQuestion, toSet } from "./store";
import type { AnswerSource, ExamAttempt, ExamState, PastQuestion, PastQuestionSet, PastQuestionSummary, PastQuestionType, TopicFrequency } from "./types";

// The real session and database for past-question and exam operations.
// Everything is derived from the signed-in user's session.
export function pastDeps(): PastDeps {
  return {
    getUser: getCurrentUser,
    openStore: async (userId) => new SupabasePastStore(await createClient(), userId),
    // The same weak areas the performance page shows.
    getWeakTopics: async () => (await getPerformance())?.weakAreas.map((area) => area.topic) ?? [],
  };
}

export async function processingDeps(): Promise<PastProcessingDeps | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return { store: new SupabasePastStore(await createClient(), user.id), getModel: getTutorModel };
}

// Reads a newly uploaded paper on the server after the current response has
// been sent. The browser is not involved: it can navigate away and the work
// continues, for as long as the hosting platform lets the request live
// (`maxDuration` on the pages that upload).
export function schedulePastProcessing(setId: string, userId: string, accessToken: string) {
  after(async () => {
    try {
      await processPastQuestionSet(setId, { store: new SupabasePastStore(createUserClient(accessToken), userId), getModel: getTutorModel });
    } catch (error) {
      console.error("[past-questions] run crashed", { setId, detail: (error as Error).message });
    }
  });
}

// Every query below runs as the signed-in user, so Row Level Security limits
// the results to that user's rows. The explicit user_id filters state the
// intent and let Postgres use the user_id indexes.

type Row = Record<string, unknown>;

export type SetListItem = PastQuestionSet & {
  // True when a 'processing' paper has run so long it is assumed abandoned.
  stale: boolean;
  questions: number;
  // Questions with an answer to mark against, and how many of those answers
  // are the paper's own.
  answerable: number;
  official: number;
  // Text kept as it was read because it was not clearly a question.
  raw: number;
  years: number[];
};

export type SessionListItem = {
  quizId: string;
  attemptId: string | null;
  title: string;
  mode: Quiz["mode"];
  subjectId: string | null;
  setId: string | null;
  questions: number;
  score: number | null;
  timeUsedSeconds: number | null;
  timeLimitSeconds: number | null;
  startedAt: string;
  completedAt: string | null;
};

function withStale(set: PastQuestionSet) {
  const startedAt = set.processingStartedAt ? Date.parse(set.processingStartedAt) : 0;
  return { ...set, stale: set.status === "processing" && Date.now() - startedAt > PAST.staleProcessingMinutes * 60_000 };
}

async function loadSummaries(store: SupabasePastStore, supabase: Awaited<ReturnType<typeof createClient>>, userId: string, sets: PastQuestionSet[]) {
  const [rows, history] = await Promise.all([
    supabase
      .from("past_questions")
      .select("id, set_id, question_type, exam_year, topic, difficulty, answer_source")
      .eq("user_id", userId)
      .limit(PAST.maxListedQuestions),
    store.getHistory(),
  ]);
  if (rows.error) throw new Error(`past_questions select: ${rows.error.code}`);

  const yearOfSet = new Map(sets.map((set) => [set.id, set.year]));
  return (rows.data as Row[]).map((row): PastQuestionSummary => ({
    id: row.id as string,
    setId: row.set_id as string,
    type: row.question_type as PastQuestionType,
    year: (row.exam_year as number | null) ?? yearOfSet.get(row.set_id as string) ?? null,
    topic: (row.topic as string | null) ?? null,
    difficulty: (row.difficulty as Difficulty | null) ?? null,
    answerable: row.question_type !== "raw" && row.answer_source !== "answer_unavailable",
    answerSource: row.answer_source as AnswerSource,
    lastResult: (history.get(row.id as string) as AnswerResult | undefined) ?? null,
  }));
}

function toSetList(sets: PastQuestionSet[], summaries: PastQuestionSummary[]): SetListItem[] {
  return sets.map((set) => {
    const own = summaries.filter((question) => question.setId === set.id);
    const structured = own.filter((question) => question.type !== "raw");
    return {
      ...withStale(set),
      questions: structured.length,
      answerable: structured.filter((question) => question.answerable).length,
      official: structured.filter((question) => question.answerSource === "official").length,
      raw: own.length - structured.length,
      years: [...new Set(structured.map((question) => question.year).filter((year): year is number => year !== null))].sort((a, b) => a - b),
    };
  });
}

async function loadSessions(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, modes: Quiz["mode"][], limit: number): Promise<SessionListItem[]> {
  const { data, error } = await supabase
    .from("quizzes")
    .select(`${QUIZ_COLUMNS}, past_question_set_id, quiz_attempts(${EXAM_ATTEMPT_COLUMNS})`)
    .eq("user_id", userId)
    .in("mode", modes)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`sessions select: ${error.code}`);

  return (data as unknown as (Row & { quiz_attempts: Row[] })[]).flatMap((row): SessionListItem[] => {
    const quiz = toQuiz(row);
    const base = { quizId: quiz.id, title: quiz.title, mode: quiz.mode, subjectId: quiz.subjectId, setId: (row.past_question_set_id as string | null) ?? null, questions: quiz.questionCount };
    const attempts = row.quiz_attempts.map(toExamAttempt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (attempts.length === 0) return [{ ...base, attemptId: null, score: null, timeUsedSeconds: null, timeLimitSeconds: null, startedAt: quiz.createdAt, completedAt: null }];
    return attempts.map((attempt) => ({
      ...base,
      attemptId: attempt.id,
      questions: attempt.totalQuestions,
      score: attempt.score,
      timeUsedSeconds: attempt.timeUsedSeconds,
      timeLimitSeconds: attempt.timeLimitSeconds,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    }));
  });
}

export type PastQuestionsPage = {
  subjects: SubjectOption[];
  sets: SetListItem[];
  summaries: PastQuestionSummary[];
  frequentTopics: TopicFrequency[];
  sessions: SessionListItem[];
  // Questions matching the search, or null when nothing was searched for.
  search: { query: string; results: (Pick<PastQuestion, "id" | "setId" | "number" | "question" | "topic" | "year">)[] } | null;
};

export async function getPastQuestionsPage(query: string | null): Promise<PastQuestionsPage | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const store = new SupabasePastStore(supabase, user.id);
  const [subjects, sets] = await Promise.all([getSubjects(), store.listSets()]);
  const [summaries, sessions] = await Promise.all([
    loadSummaries(store, supabase, user.id, sets),
    loadSessions(supabase, user.id, ["past_practice"], PAST.recentSessions),
  ]);

  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const subjectOfSet = new Map(sets.map((set) => [set.id, subjectNames.get(set.subjectId) ?? ""]));

  let search: PastQuestionsPage["search"] = null;
  const text = (query ?? "").replace(/\s+/g, " ").trim().slice(0, PAST.maxSearchLength);
  if (text) {
    // The wildcard characters of LIKE are matched literally.
    const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const { data, error } = await supabase
      .from("past_questions")
      .select("id, set_id, question_number, question, topic, exam_year")
      .eq("user_id", user.id)
      .neq("question_type", "raw")
      .ilike("question", pattern)
      .order("set_id")
      .order("position")
      .limit(PAST.searchResults);
    if (error) throw new Error(`past_questions search: ${error.code}`);
    search = {
      query: text,
      results: (data as Row[]).map((row) => ({
        id: row.id as string,
        setId: row.set_id as string,
        number: (row.question_number as string | null) ?? null,
        question: row.question as string,
        topic: (row.topic as string | null) ?? null,
        year: (row.exam_year as number | null) ?? null,
      })),
    };
  }

  return {
    subjects: subjects.map(({ id, name, color, icon }) => ({ id, name, color, icon })),
    sets: toSetList(sets, summaries),
    summaries,
    frequentTopics: topicFrequency(summaries, subjectOfSet),
    sessions,
    search,
  };
}

export type PastSetPage = {
  set: SetListItem;
  subjectName: string;
  questions: (PastQuestion & { lastResult: AnswerResult | null })[];
  frequentTopics: TopicFrequency[];
  sessions: SessionListItem[];
};

// Returns null when the collection does not exist OR belongs to someone
// else. The two cases are deliberately indistinguishable to the caller.
export async function getPastSetPage(id: string): Promise<PastSetPage | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(id)) return null;

  const supabase = await createClient();
  const store = new SupabasePastStore(supabase, user.id);
  const set = await store.getSet(id);
  if (!set) return null;

  const [subject, questions, history, sessions] = await Promise.all([
    store.getSubject(set.subjectId),
    store.listQuestions([set.id]),
    store.getHistory(),
    loadSessions(supabase, user.id, ["past_practice", "exam"], 100),
  ]);

  const dated = questions.map((question) => ({ ...question, year: question.year ?? set.year, lastResult: history.get(question.id) ?? null }));
  const summaries = dated.map((question): PastQuestionSummary => ({
    id: question.id, setId: question.setId, type: question.type, year: question.year, topic: question.topic, difficulty: question.difficulty,
    answerable: question.type !== "raw" && question.correctAnswer !== null, answerSource: question.answerSource, lastResult: question.lastResult,
  }));

  return {
    set: toSetList([set], summaries)[0],
    subjectName: subject?.name ?? "",
    questions: dated,
    frequentTopics: topicFrequency(summaries, new Map([[set.id, subject?.name ?? ""]])),
    sessions: sessions.filter((session) => session.setId === set.id).slice(0, PAST.recentSessions),
  };
}

export type ExamHome = {
  subjects: SubjectOption[];
  sets: SetListItem[];
  summaries: PastQuestionSummary[];
  history: SessionListItem[];
};

export async function getExamHome(): Promise<ExamHome | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const store = new SupabasePastStore(supabase, user.id);
  const [subjects, sets] = await Promise.all([getSubjects(), store.listSets()]);
  const [summaries, history] = await Promise.all([loadSummaries(store, supabase, user.id, sets), loadSessions(supabase, user.id, ["exam"], 60)]);

  return {
    subjects: subjects.map(({ id, name, color, icon }) => ({ id, name, color, icon })),
    sets: toSetList(sets, summaries),
    summaries,
    history: history.filter((item) => item.attemptId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  };
}

export type ExamPage =
  | { status: "open"; quiz: Quiz; attempt: ExamAttempt; questions: ExamQuestion[]; state: ExamState; remainingSeconds: number | null; subjectName: string | null }
  | { status: "finished"; review: ExamReview; subjectName: string | null };

// An open exam is returned with its questions only: no answers, no
// explanations, no topics. A finished one is returned as its review. Null
// for an unknown id and for another user's exam alike.
export async function getExamPage(attemptId: string): Promise<ExamPage | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(attemptId)) return null;

  const store = new SupabasePastStore(await createClient(), user.id);
  const attempt = await store.getAttempt(attemptId);
  if (!attempt) return null;
  const quiz = await store.getQuiz(attempt.quizId);
  if (!quiz || quiz.mode !== "exam") return null;

  const [questions, subject] = await Promise.all([store.getQuestions(quiz.id), quiz.subjectId ? store.getSubject(quiz.subjectId) : null]);
  const subjectName = subject?.name ?? null;

  if (attempt.completedAt) {
    return { status: "finished", review: reviewExam(quiz, attempt, questions, await store.getAnswers(attempt.id)), subjectName };
  }
  return {
    status: "open",
    quiz,
    attempt,
    questions: questions.map(toExamQuestion),
    state: { answers: attempt.state.answers, flagged: attempt.state.flagged },
    remainingSeconds: secondsRemaining(attempt, new Date()),
    subjectName,
  };
}

// ------------------------------------------------------------ Ask Ari

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function explainMessage(input: {
  opening: string;
  question: string;
  options: string[];
  myAnswer?: string | null;
  correctAnswer: string | boolean | null;
  answerSource: AnswerSource;
  explanation: string | null;
  topic: string | null;
  source: string;
}) {
  const lines = [input.opening, "", `Question: ${clip(input.question, 700)}`];
  if (input.options.length > 0) lines.push(`Options: ${input.options.map((option, index) => `${String.fromCharCode(65 + index)}) ${clip(option, 200)}`).join("  ")}`);
  if (input.myAnswer !== undefined) lines.push(`My answer: ${input.myAnswer ?? "(I didn't answer)"}`);

  if (input.correctAnswer === null) lines.push("My paper has no answer key for this question, so I don't know the correct answer.");
  else if (input.answerSource === "ai_generated") lines.push(`Suggested answer (worked out by Ari; my paper has no answer key, so please check it): ${clip(answerText(input.correctAnswer), 600)}`);
  else lines.push(`Correct answer (from my paper's answer key): ${clip(answerText(input.correctAnswer), 600)}`);

  if (input.explanation) lines.push(`Explanation I was given: ${clip(input.explanation, 900)}`);
  if (input.topic && input.topic !== UNCATEGORIZED) lines.push(`Topic: ${clip(input.topic, 80)}`);
  lines.push(`Source: ${input.source}`);
  return clip(lines.join("\n"), TUTOR.maxMessageLength);
}

type ExplainRequest = { message: string; subjectId: string | null };

// "Ask Ari to explain" for a past question on its collection page: the
// message that opens a tutor conversation about it, in the collection's
// subject, so the tutor searches the student's own notes for it as it does
// for any other question. Null for an unknown question and for another
// user's question alike.
export async function getPastQuestionExplainRequest(pastQuestionId: string): Promise<ExplainRequest | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(pastQuestionId)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.from("past_questions").select(PAST_QUESTION_COLUMNS).eq("user_id", user.id).eq("id", pastQuestionId).maybeSingle();
  if (error || !data) return null;
  const question = toPastQuestion(data as unknown as Row);
  if (question.type === "raw") return null;

  const { data: setRow } = await supabase.from("past_question_sets").select(SET_COLUMNS).eq("user_id", user.id).eq("id", question.setId).maybeSingle();
  if (!setRow) return null;
  const set = toSet(setRow as unknown as Row);

  return {
    subjectId: set.subjectId,
    message: explainMessage({
      opening: "Can you explain this past exam question to me, and how to work out the answer?",
      question: question.question,
      options: question.options,
      correctAnswer: question.correctAnswer,
      answerSource: question.answerSource,
      explanation: question.explanation,
      topic: question.topic,
      source: [set.title, question.year ?? set.year, question.number ? `question ${question.number}` : null].filter(Boolean).join(" — "),
    }),
  };
}

// The same for a question in a finished exam that was left unanswered (an
// answered one uses the existing /tutor?explain=<answer id>). Nothing is
// returned while the exam is still open: that would reveal its answer.
export async function getExamQuestionExplainRequest(questionId: string): Promise<ExplainRequest | null> {
  const user = await getCurrentUser();
  if (!user || !isUuid(questionId)) return null;

  const supabase = await createClient();
  const store = new SupabasePastStore(supabase, user.id);
  const { data, error } = await supabase.from("quiz_questions").select("quiz_id").eq("user_id", user.id).eq("id", questionId).maybeSingle();
  if (error || !data) return null;

  const quiz = await store.getQuiz(data.quiz_id as string);
  if (!quiz || (quiz.mode !== "exam" && quiz.mode !== "past_practice")) return null;
  const { count } = await supabase
    .from("quiz_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("quiz_id", quiz.id)
    .not("completed_at", "is", null);
  if (!count) return null;

  const question = (await store.getQuestions(quiz.id)).find((item) => item.id === questionId);
  if (!question) return null;
  return {
    subjectId: quiz.subjectId,
    message: explainMessage({
      opening: "I left this exam question unanswered. Can you explain it to me?",
      question: question.question,
      options: question.options,
      myAnswer: null,
      correctAnswer: question.correctAnswer,
      answerSource: question.answerSource ?? "official",
      explanation: question.explanationSource ? question.explanation : null,
      topic: question.topic,
      source: question.source?.title ?? quiz.title,
    }),
  };
}
