"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { analyzePastSetAction, deletePastQuestionSet, retryPastProcessingAction } from "@/app/(app)/past-questions/actions";
import { formatScore, percent } from "@/components/practice/scope-fields";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { answerText } from "@/lib/ai/practice/explain";
import { formatCount, formatDate } from "@/lib/library/format";
import { UNCATEGORIZED } from "@/lib/past-questions/config";
import type { PastSetPage } from "@/lib/past-questions/queries";
import type { PastQuestionSummary } from "@/lib/past-questions/types";
import { AnswerSourceLabel } from "./answer-source";
import { SET_STATUS_LABELS, setHeading } from "./past-questions-view";
import { PracticeDialog } from "./practice-dialog";

const POLL_INTERVAL_MS = 4000;
const POLL_LIMIT_MS = 6 * 60_000;

const TYPE_LABELS = { multiple_choice: "Multiple choice", true_false: "True / false", short_answer: "Written answer", raw: "Unread text" };
const RESULT_LABELS = { correct: "Last answer: correct", partial: "Last answer: partly right", incorrect: "Last answer: incorrect" };

export function CollectionView({ set, subjectName, questions, frequentTopics, sessions }: PastSetPage) {
  const router = useRouter();
  const toast = useToast();
  const [practising, setPractising] = useState(false);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState<"retry" | "analyse" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const reading = (set.status === "pending" || set.status === "processing") && !set.stale;
  useEffect(() => {
    if (!reading) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) window.clearInterval(timer);
      else router.refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reading, router]);

  const structured = questions.filter((question) => question.type !== "raw");
  const raw = questions.filter((question) => question.type === "raw");
  const topics = [...new Set(structured.map((question) => question.topic ?? UNCATEGORIZED))].sort((a, b) => (a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b)));
  const visible = structured.filter((question) => !topic || (question.topic ?? UNCATEGORIZED) === topic);
  const unlabelled = structured.filter((question) => !question.analyzed).length;
  const aiAnswers = set.answerable - set.official;
  const summaries: PastQuestionSummary[] = questions.map((question) => ({
    id: question.id, setId: question.setId, type: question.type, year: question.year, topic: question.topic, difficulty: question.difficulty,
    answerable: question.type !== "raw" && question.correctAnswer !== null, answerSource: question.answerSource, lastResult: question.lastResult,
  }));

  async function retry() {
    setBusy("retry");
    setMessage(null);
    const result = await retryPastProcessingAction(set.id);
    setBusy(null);
    if (!result.ok) setMessage({ kind: "error", text: result.error });
    else router.refresh();
  }

  async function analyse() {
    setBusy("analyse");
    setMessage(null);
    const result = await analyzePastSetAction(set.id);
    setBusy(null);
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error });
      return;
    }
    const { analyzed = 0, remaining = 0 } = result.data ?? {};
    setMessage({ kind: "info", text: remaining > 0 ? `Ari labelled ${formatCount(analyzed, "question")}. ${formatCount(remaining, "question")} still to do: press “Analyse with Ari” again to continue.` : `Ari labelled ${formatCount(analyzed, "question")}.` });
    router.refresh();
  }

  async function remove() {
    setBusy("delete");
    const result = await deletePastQuestionSet(set.id);
    if (!result.ok) {
      setBusy(null);
      setMessage({ kind: "error", text: result.error });
      setConfirmingDelete(false);
      return;
    }
    toast("Collection deleted.");
    router.push("/past-questions");
  }

  return (
    <>
      <Link className="back-link" href="/past-questions">← Back to past questions</Link>

      <div className="subject-header">
        <span className={`file-chip type-${set.fileExtension}`}>{set.fileExtension.toUpperCase()}</span>
        <div className="subject-header-copy">
          <h1>{set.title}</h1>
          <p className="subject-header-description">
            {[setHeading(set, subjectName), set.examType, set.institution, set.courseCode].filter(Boolean).join(" · ")}
          </p>
          {set.description && <p className="subject-header-description">{set.description}</p>}
          <p className="material-meta">{set.originalFilename} · Uploaded {formatDate(set.createdAt)}</p>
        </div>
        <div className="subject-header-actions">
          <span className={`status-badge status-${set.stale ? "failed" : set.status}`}>{set.stale ? "Stopped" : SET_STATUS_LABELS[set.status]}</span>
          <button className="icon-button danger" disabled={busy !== null} onClick={() => setConfirmingDelete(true)} type="button">Delete</button>
        </div>
      </div>

      {message && <div className={`form-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div>}

      {reading && <div className="form-message info" role="status">Ari is reading this paper. This page updates by itself when it&apos;s done.</div>}
      {(set.status === "failed" || set.stale) && (
        <div className="form-message error" role="alert">
          {set.stale ? "Reading this paper stopped unexpectedly." : (set.error ?? "This paper couldn't be read.")}{" "}
          <button className="link-button" disabled={busy !== null} onClick={retry} type="button">{busy === "retry" ? "Starting…" : "Try again"}</button>
        </div>
      )}

      {set.status === "ready" && (
        <>
          <div className="stat-row four past-stats">
            <div className="stat-tile"><strong>{set.questions}</strong><span>{set.questions === 1 ? "Question read" : "Questions read"}</span></div>
            <div className="stat-tile"><strong>{set.official}</strong><span>With the paper&apos;s own answer</span></div>
            <div className="stat-tile"><strong>{aiAnswers}</strong><span>With an answer from Ari</span></div>
            <div className="stat-tile"><strong>{set.questions - set.answerable}</strong><span>With no answer available</span></div>
          </div>

          {set.questions === 0 ? (
            <div className="form-message info" role="status">
              Ari couldn&apos;t pick out separate questions in this file, so nothing here can be practised yet. The text is kept below exactly as it was read. Papers work best when each question starts with its number (“1.”, “2)”, “Question 3”) and options are lettered (“A.”, “B.”).
            </div>
          ) : (
            <>
              {set.answerable === 0 && (
                <div className="form-message info" role="status">
                  This paper has no answer key, so its questions can be read and explained but not yet marked. “Analyse with Ari” will try to work the answers out; those are always labelled as Ari&apos;s.
                </div>
              )}
              <div className="past-actions">
                <button className="action-button" disabled={set.answerable === 0} onClick={() => setPractising(true)} type="button">Practice</button>
                {set.answerable > 0 && <Link className="auth-secondary compact" href={`/exam?set=${set.id}`}>Exam</Link>}
                {unlabelled > 0 && (
                  <button aria-busy={busy === "analyse"} className="auth-secondary compact" disabled={busy !== null} onClick={analyse} type="button">
                    {busy === "analyse" && <span aria-hidden="true" className="spinner dark" />}
                    {busy === "analyse" ? "Ari is analysing…" : `Analyse with Ari (${unlabelled} unlabelled)`}
                  </button>
                )}
              </div>
            </>
          )}

          {frequentTopics.length > 0 && (
            <section aria-labelledby="set-topics" className="lower-section">
              <div className="section-heading lower-heading"><div><span aria-hidden="true" className="section-icon plan-icon">↻</span><h2 id="set-topics">Frequently tested in this collection</h2></div></div>
              <ol className="past-topics">
                {frequentTopics.map((item) => (
                  <li key={item.topic}>
                    <span><strong>{item.topic}</strong>{item.years.length > 1 && <em>{item.years.join(", ")}</em>}</span>
                    <span className="past-topic-count">{formatCount(item.questions, "question")}</span>
                  </li>
                ))}
              </ol>
              <p className="perf-note">Counted from this uploaded paper. It is not a prediction of what a future exam will contain.</p>
            </section>
          )}

          {sessions.length > 0 && (
            <section aria-labelledby="set-attempts" className="lower-section">
              <div className="section-heading lower-heading"><div><span aria-hidden="true" className="section-icon plan-icon">✓</span><h2 id="set-attempts">Previous attempts</h2></div></div>
              <ul className="practice-list">
                {sessions.map((session) => (
                  <li className="practice-item" key={session.attemptId ?? session.quizId}>
                    <Link className="practice-item-link" href={session.mode === "exam" && session.attemptId ? `/exam/${session.attemptId}` : `/quizzes/${session.quizId}`}>
                      <span className="practice-item-copy">
                        <strong>{session.title}</strong>
                        <span>{session.mode === "exam" && <em className="practice-tag">Exam</em>}{formatCount(session.questions, "question")}<i aria-hidden="true">·</i>{formatDate(session.startedAt)}</span>
                      </span>
                      {session.completedAt && session.score !== null ? (
                        <span className="practice-score"><strong>{formatScore(session.score, session.questions)}</strong><span>{percent(session.score, session.questions)}%</span></span>
                      ) : (
                        <span className="status-badge">{session.attemptId ? "In progress" : "Not started"}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {structured.length > 0 && (
            <section aria-labelledby="set-questions" className="lower-section">
              <div className="section-heading lower-heading">
                <div><span aria-hidden="true" className="section-icon library-icon">❖</span><h2 id="set-questions">Questions</h2></div>
                {topics.length > 1 && (
                  <select aria-label="Filter questions by topic" className="field-input past-topic-filter" onChange={(event) => setTopic(event.target.value)} value={topic}>
                    <option value="">All topics</option>
                    {topics.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                )}
              </div>
              <ol className="past-questions">
                {visible.map((question) => (
                  <li className="quiz-panel" id={`q-${question.id}`} key={question.id}>
                    <div className="quiz-review-head">
                      <span>
                        {question.number ? `Question ${question.number}` : "Question"} · {TYPE_LABELS[question.type]}
                        {question.year && ` · ${question.year}`}
                        {question.page && ` · page ${question.page}`}
                        {question.slide && ` · slide ${question.slide}`}
                      </span>
                      <span className="past-question-tags">
                        {question.analyzed && <span className="status-badge">{question.topic ?? UNCATEGORIZED}</span>}
                        {question.lastResult && <span className={`status-badge quiz-badge is-${question.lastResult}`}>{RESULT_LABELS[question.lastResult]}</span>}
                      </span>
                    </div>
                    <p className="quiz-question past-question-text">{question.question}</p>
                    {question.options.length > 0 && (
                      <ul className="quiz-review-options">
                        {question.options.map((option, index) => <li key={option}><span aria-hidden="true">{String.fromCharCode(65 + index)}</span>{option}</li>)}
                      </ul>
                    )}
                    <div className="quiz-feedback-footer">
                      {question.correctAnswer === null || question.answerSource === "answer_unavailable" ? (
                        <span className="answer-source is-none">No answer available: this paper has no answer key for it.</span>
                      ) : (
                        <details className="past-answer">
                          <summary>Show answer</summary>
                          <p><strong>{answerText(question.correctAnswer)}</strong></p>
                          <AnswerSourceLabel source={question.answerSource} />
                          {question.explanation && <p>{question.explanation}{question.explanationSource === "ai_generated" && question.answerSource === "official" && " (explanation by Ari)"}</p>}
                        </details>
                      )}
                      <Link className="link-button" href={`/tutor?explainPast=${question.id}`}>Ask Ari to explain <span aria-hidden="true">→</span></Link>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {raw.length > 0 && (
            <section aria-labelledby="set-raw" className="lower-section">
              <details className="deck-all">
                <summary id="set-raw">Text Ari couldn&apos;t read as questions ({raw.length})</summary>
                <p className="perf-note past-raw-note">Kept exactly as it was extracted, rather than guessed into questions. It is not used for practice or exams.</p>
                <ol>
                  {raw.map((entry) => <li className="past-raw" key={entry.id}>{entry.question}</li>)}
                </ol>
              </details>
            </section>
          )}
        </>
      )}

      {practising && <PracticeDialog onClose={() => setPractising(false)} scope={set.title} setIds={[set.id]} summaries={summaries} />}
      {confirmingDelete && (
        <ConfirmDialog confirmLabel="Delete collection" onClose={() => setConfirmingDelete(false)} onConfirm={remove} pending={busy === "delete"} pendingLabel="Deleting…" title="Delete this collection?">
          <p>“{set.title}”, its file and the questions read from it will be permanently deleted.</p>
          <p>Practice sessions and exams you have already taken from it are kept, with their scores.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
