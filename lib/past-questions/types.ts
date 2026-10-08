import type { AnswerResult, Difficulty, QuestionType, QuizAttempt } from "@/lib/ai/practice/types";

// Shapes shared by the past-question and exam server code and their UI. No
// server-only imports, so client components can use these types.

export type PastQuestionType = QuestionType | "raw";
// 'official' is the uploaded paper's own answer; 'ai_generated' is Ari's.
export type AnswerSource = "official" | "ai_generated" | "answer_unavailable";
export type KnownAnswerSource = Exclude<AnswerSource, "answer_unavailable">;
export type SetStatus = "pending" | "processing" | "ready" | "failed";
export type AnalysisStatus = "pending" | "partial" | "complete";

export type PastQuestionSet = {
  id: string;
  subjectId: string;
  title: string;
  examType: string | null;
  institution: string | null;
  year: number | null;
  courseCode: string | null;
  description: string | null;
  originalFilename: string;
  fileExtension: string;
  status: SetStatus;
  error: string | null;
  processingStartedAt: string | null;
  analysisStatus: AnalysisStatus;
  createdAt: string;
};

export type PastQuestion = {
  id: string;
  setId: string;
  position: number;
  number: string | null;
  type: PastQuestionType;
  question: string;
  options: string[];
  // Null when no answer is known.
  correctAnswer: string | boolean | null;
  answerSource: AnswerSource;
  explanation: string | null;
  explanationSource: KnownAnswerSource | null;
  // The question's own year when the paper gave one, else the collection's.
  year: number | null;
  // Null until analysed.
  topic: string | null;
  difficulty: Difficulty | null;
  analyzed: boolean;
  page: number | null;
  slide: number | null;
};

// What the question parser produces from an uploaded paper.
export type ParsedQuestion = {
  number: string | null;
  type: PastQuestionType;
  question: string;
  options: string[];
  // Only ever an answer the paper itself gave.
  correctAnswer: string | boolean | null;
  explanation: string | null;
  year: number | null;
  page: number | null;
  slide: number | null;
};

// Just enough of every question to filter, count and choose from, without
// sending question text or answers to the browser.
export type PastQuestionSummary = {
  id: string;
  setId: string;
  type: PastQuestionType;
  year: number | null;
  topic: string | null;
  difficulty: Difficulty | null;
  // True when the question can be marked (it has an answer of either kind).
  answerable: boolean;
  answerSource: AnswerSource;
  // How the student did the last time they answered it. Null if never.
  lastResult: AnswerResult | null;
};

export type ExamState = {
  // By quiz question id: an option's position, or true/false.
  answers: Record<string, number | boolean>;
  flagged: string[];
  // True when the exam was submitted after its time had run out.
  late?: boolean;
};

export type ExamAttempt = QuizAttempt & {
  // Null means untimed.
  timeLimitSeconds: number | null;
  timeUsedSeconds: number | null;
  state: ExamState;
};

export type TopicFrequency = { topic: string; subjectName: string; questions: number; years: number[] };
