"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { deleteQuizAction, generateQuizAction } from "@/app/(app)/quizzes/actions";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { PRACTICE } from "@/lib/ai/practice/config";
import type { QuizListItem } from "@/lib/ai/practice/queries";
import type { DifficultyChoice, GenerateQuizInput, QuestionTypeChoice } from "@/lib/ai/practice/types";
import { formatDate } from "@/lib/library/format";
import type { SubjectOption } from "@/lib/library/types";
import { EMPTY_SCOPE, formatScore, percent, ScopeFields, type MaterialOption, type Scope } from "./scope-fields";

const DIFFICULTY_LABELS: Record<DifficultyChoice, string> = { mixed: "Mixed", easy: "Easy", medium: "Medium", hard: "Hard" };
const TYPE_LABELS: Record<QuestionTypeChoice, string> = {
  mixed: "Mixed",
  multiple_choice: "Multiple choice",
  true_false: "True / false",
  short_answer: "Short answer",
};

type Props = {
  subjects: SubjectOption[];
  materials: MaterialOption[];
  quizzes: QuizListItem[];
  // False when no chat model is configured on the server.
  enabled: boolean;
  // True when the quiz list could not be loaded.
  listFailed: boolean;
};

export function QuizzesView({ subjects, materials, enabled, listFailed, ...props }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [quizzes, setQuizzes] = useState(props.quizzes);
  const [scope, setScope] = useState<Scope>(EMPTY_SCOPE);
  const [practiceScope, setPracticeScope] = useState<Scope>(EMPTY_SCOPE);
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState<DifficultyChoice>("mixed");
  const [questionType, setQuestionType] = useState<QuestionTypeChoice>("mixed");
  // Which of the two forms is generating. Both are locked while either is.
  const [generating, setGenerating] = useState<"quiz" | "practice" | null>(null);
  const [error, setError] = useState<{ form: "quiz" | "practice"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<QuizListItem | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const canGenerate = enabled && materials.length > 0 && !generating;
  const completed = quizzes.filter((quiz) => quiz.lastCompleted);

  async function generate(form: "quiz" | "practice", input: GenerateQuizInput) {
    // A second click while Ari is writing must not start a second quiz.
    if (generating) return;
    setGenerating(form);
    setError(null);

    const result = await generateQuizAction(input);
    if (!result.ok) {
      setError({ form, text: result.error });
      setGenerating(null);
      return;
    }
    if (result.data.delivered < result.data.requested) {
      toast(`Ari wrote ${result.data.delivered} good questions from this material instead of ${result.data.requested}.`);
    }
    // Stay locked until the quiz page has replaced this one.
    router.push(`/quizzes/${result.data.quizId}`);
  }

  function createQuiz(event: FormEvent) {
    event.preventDefault();
    void generate("quiz", { subjectId: scope.subjectId || null, materialId: scope.materialId || null, topic: scope.topic, count, difficulty, questionType });
  }

  function startPractice(event: FormEvent) {
    event.preventDefault();
    void generate("practice", { mode: "practice", subjectId: practiceScope.subjectId || null, materialId: practiceScope.materialId || null, topic: practiceScope.topic });
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    const result = await deleteQuizAction(deleting.id);
    setDeletePending(false);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setQuizzes((list) => list.filter((quiz) => quiz.id !== deleting.id));
    toast("Quiz deleted.");
    setDeleting(null);
  }

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> PRACTISE WHAT YOU&apos;VE LEARNED</p>
          <h1>Quizzes<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Ari writes questions from your own study materials, then explains every answer.</p>
        </div>
        {completed.length > 0 && (
          <div className="practice-tally" aria-label="Your quiz totals">
            <span><strong>{completed.length}</strong> {completed.length === 1 ? "quiz" : "quizzes"} completed</span>
          </div>
        )}
      </div>

      {!enabled && (
        <div className="form-message info" role="status">Ari isn&apos;t set up to create quizzes yet. Once a chat model is configured on the server, you can start one here.</div>
      )}
      {enabled && materials.length === 0 && (
        <div className="form-message info" role="status">
          Quizzes are written from your study materials, and none are ready yet. <Link className="link-button" href="/materials">Upload a PDF, PowerPoint, Word document or text file</Link>, then come back once it shows “Ready for Ari”.
        </div>
      )}

      <div className="practice-grid">
        <form aria-labelledby="quiz-form-title" className="practice-card" onSubmit={createQuiz}>
          <h2 id="quiz-form-title">Start a quiz</h2>
          <p className="practice-card-note">Choose what to be tested on and how.</p>

          <ScopeFields disabled={!canGenerate} idPrefix="quiz" materials={materials} onChange={setScope} subjects={subjects} topicMaxLength={PRACTICE.maxTopicLength} value={scope} />

          <div className="practice-row">
            <div className="field">
              <label htmlFor="quiz-count">Questions</label>
              <select className="field-input" disabled={!canGenerate} id="quiz-count" onChange={(event) => setCount(Number(event.target.value))} value={count}>
                {PRACTICE.quizSizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="quiz-difficulty">Difficulty</label>
              <select className="field-input" disabled={!canGenerate} id="quiz-difficulty" onChange={(event) => setDifficulty(event.target.value as DifficultyChoice)} value={difficulty}>
                {Object.entries(DIFFICULTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="quiz-type">Question type</label>
            <select className="field-input" disabled={!canGenerate} id="quiz-type" onChange={(event) => setQuestionType(event.target.value as QuestionTypeChoice)} value={questionType}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>

          {error?.form === "quiz" && <div className="form-message error" role="alert">{error.text}</div>}
          <button aria-busy={generating === "quiz"} className="auth-submit" disabled={!canGenerate} type="submit">
            {generating === "quiz" && <span aria-hidden="true" className="spinner" />}
            {generating === "quiz" ? "Writing your quiz…" : "Create quiz"}
          </button>
          {generating === "quiz" && <p className="practice-wait" role="status">Ari is reading your material and writing questions. This can take up to a minute.</p>}
        </form>

        <form aria-labelledby="practice-form-title" className="practice-card" onSubmit={startPractice}>
          <h2 id="practice-form-title">Quick practice</h2>
          <p className="practice-card-note">{PRACTICE.practiceSize} mixed questions, no setup. Good for a few minutes of active recall.</p>

          <ScopeFields disabled={!canGenerate} idPrefix="practice" materials={materials} onChange={setPracticeScope} subjects={subjects} topicMaxLength={PRACTICE.maxTopicLength} value={practiceScope} />

          {error?.form === "practice" && <div className="form-message error" role="alert">{error.text}</div>}
          <button aria-busy={generating === "practice"} className="auth-secondary" disabled={!canGenerate} type="submit">
            {generating === "practice" && <span aria-hidden="true" className="spinner dark" />}
            {generating === "practice" ? "Getting questions ready…" : "Start practice"}
          </button>
          {generating === "practice" && <p className="practice-wait" role="status">Ari is picking out questions. This can take up to a minute.</p>}
        </form>
      </div>

      <section aria-labelledby="quiz-history-title" className="lower-section">
        <div className="section-heading lower-heading">
          <div><span aria-hidden="true" className="section-icon plan-icon">✓</span><h2 id="quiz-history-title">Your quizzes</h2></div>
        </div>

        {listFailed ? (
          <div className="form-message error" role="alert">We couldn&apos;t load your quizzes just now. Refresh the page to try again.</div>
        ) : quizzes.length === 0 ? (
          <div className="library-empty compact">
            <strong>No quizzes yet.</strong>
            <p>Your quizzes and scores will be listed here.</p>
          </div>
        ) : (
          <ul className="practice-list">
            {quizzes.map((quiz) => (
              <li className="practice-item" key={quiz.id}>
                <Link className="practice-item-link" href={`/quizzes/${quiz.id}`}>
                  <span className="practice-item-copy">
                    <strong>{quiz.title}</strong>
                    <span>
                      {quiz.mode === "practice" && <em className="practice-tag">Practice</em>}
                      {quiz.subjectId && subjectNames.has(quiz.subjectId) ? subjectNames.get(quiz.subjectId) : "All subjects"}
                      <i aria-hidden="true">·</i>{quiz.questionCount} questions
                      <i aria-hidden="true">·</i>{DIFFICULTY_LABELS[quiz.difficulty]}
                      <i aria-hidden="true">·</i>{formatDate(quiz.createdAt)}
                    </span>
                  </span>
                  {quiz.lastCompleted && quiz.lastCompleted.score !== null ? (
                    <span className="practice-score">
                      <strong>{formatScore(quiz.lastCompleted.score, quiz.lastCompleted.totalQuestions)}</strong>
                      <span>{percent(quiz.lastCompleted.score, quiz.lastCompleted.totalQuestions)}%{quiz.inProgress ? " · retake in progress" : ""}</span>
                    </span>
                  ) : (
                    <span className="status-badge">{quiz.inProgress ? "In progress" : "Not started"}</span>
                  )}
                </Link>
                <button
                  aria-label={`Delete quiz: ${quiz.title}`}
                  className="icon-button danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(quiz);
                  }}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete quiz"
          error={deleteError}
          onClose={() => setDeleting(null)}
          onConfirm={confirmDelete}
          pending={deletePending}
          pendingLabel="Deleting…"
          title="Delete this quiz?"
        >
          <p>“{deleting.title}”, its questions and your results for it will be permanently deleted.</p>
          <p>This can&apos;t be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
