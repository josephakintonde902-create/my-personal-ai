import type { TutorSource } from "../tutor/types";
import type { DIFFICULTIES, QUESTION_TYPES, RATINGS } from "./config";

// Shapes shared by the quiz and flashcard server code and their UI. No
// server-only imports, so client components can use these types.

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type Rating = (typeof RATINGS)[number];
export type DifficultyChoice = Difficulty | "mixed";
export type QuestionTypeChoice = QuestionType | "mixed";
export type AnswerResult = "correct" | "partial" | "incorrect";

// Where a question or card came from. The same shape the tutor uses, so
// sources are labelled the same way everywhere ("Lecture 4 — slide 18").
export type PracticeSource = TutorSource;

// ------------------------------------------------------------------ quizzes

// A validated question, ready to be stored.
export type QuestionDraft = {
  type: QuestionType;
  question: string;
  // Multiple choice: four options in display order. Otherwise empty.
  options: string[];
  // Multiple choice: the correct option's text. True/false: a boolean.
  // Short answer: the expected answer.
  correctAnswer: string | boolean;
  // Short answer: the ideas a correct answer contains.
  acceptablePoints: string[];
  explanation: string;
  topic: string;
  difficulty: Difficulty;
  source: PracticeSource | null;
  // Part of the passage the question was written from.
  sourceExcerpt: string;
  // Only on questions copied from an uploaded past paper: whether the answer
  // is the paper's own or Ari's.
  answerSource?: "official" | "ai_generated";
};

export type QuizQuestion = QuestionDraft & { id: string; position: number };

// What the browser is given before a question is answered: no correct
// answer, no explanation.
export type PublicQuestion = Pick<QuizQuestion, "id" | "position" | "type" | "question" | "options">;

export type Quiz = {
  id: string;
  title: string;
  // 'past_practice' and 'exam' are made from uploaded past questions
  // (lib/past-questions); the other two are written by Ari.
  mode: "quiz" | "practice" | "past_practice" | "exam";
  subjectId: string | null;
  materialId: string | null;
  difficulty: DifficultyChoice;
  questionCount: number;
  questionTypes: QuestionType[];
  createdAt: string;
};

export type QuizAttempt = {
  id: string;
  quizId: string;
  // Null until completed.
  score: number | null;
  totalQuestions: number;
  startedAt: string;
  completedAt: string | null;
};

export type QuizAnswer = {
  id: string;
  attemptId: string;
  questionId: string;
  answer: string | boolean;
  result: AnswerResult;
  // The evaluator's note on a short answer. Empty otherwise.
  feedback: string;
  answeredAt: string;
};

// What the student sees after answering.
export type AnswerFeedback = {
  answerId: string;
  questionId: string;
  answer: string | boolean;
  result: AnswerResult;
  correctAnswer: string | boolean;
  explanation: string;
  feedback: string;
  source: PracticeSource | null;
  topic: string;
  // Present for past-paper questions only.
  answerSource?: "official" | "ai_generated";
};

export type QuizSummary = {
  attempt: QuizAttempt;
  // Topics with at least one answer that was not fully correct, in this
  // attempt only.
  weakAreas: { topic: string; missed: number; total: number }[];
};

export type GenerateQuizInput = {
  subjectId?: string | null;
  materialId?: string | null;
  count?: number;
  difficulty?: DifficultyChoice;
  questionType?: QuestionTypeChoice;
  // Optional: what to focus on.
  topic?: string;
  mode?: "quiz" | "practice";
};

// --------------------------------------------------------------- flashcards

export type CardDraft = {
  front: string;
  back: string;
  difficulty: Difficulty;
  source: PracticeSource | null;
};

export type Flashcard = CardDraft & { id: string; position: number };

export type FlashcardDeck = {
  id: string;
  title: string;
  subjectId: string | null;
  materialId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerateDeckInput = {
  subjectId?: string | null;
  materialId?: string | null;
  count?: number;
  topic?: string;
};
