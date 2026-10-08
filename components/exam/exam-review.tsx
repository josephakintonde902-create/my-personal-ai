import Link from "next/link";
import { AnswerSourceLabel } from "@/components/past-questions/answer-source";
import { MistakePractice } from "@/components/past-questions/mistake-practice";
import { answerText } from "@/lib/ai/practice/explain";
import { formatDate } from "@/lib/library/format";
import { formatDuration } from "@/lib/past-questions/format";
import type { ExamReview as Review } from "@/lib/past-questions/sessions";
import { NO_EXPLANATION } from "@/lib/past-questions/store";

// The result of a submitted exam. Everything here was worked out on the
// server from the stored answers; this component only lays it out.

const RESULT_LABELS = { correct: "Correct", incorrect: "Incorrect", unanswered: "Not answered" };
const TYPE_LABELS: Record<string, string> = { multiple_choice: "Multiple choice", true_false: "True / false", short_answer: "Written answer" };
const DIFFICULTY_LABELS: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

function Meter({ fraction }: { fraction: number }) {
  const level = fraction >= 0.8 ? "strong" : fraction >= 0.6 ? "developing" : "needs_review";
  return (
    <span className="perf-accuracy">
      <span aria-hidden="true" className={`perf-meter is-${level}`}><span style={{ width: `${Math.max(fraction * 100, 2)}%` }} /></span>
      <strong>{percent(fraction)}</strong>
    </span>
  );
}

function BreakdownTable<K extends string>({ caption, column, rows, labelOf }: { caption: string; column: K; rows: ({ [key in K]: string } & { correct: number; total: number; accuracy: number })[]; labelOf?: (value: string) => string }) {
  return (
    <div className="perf-table-wrap">
      <table className="perf-table exam-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr><th scope="col">{caption}</th><th scope="col">Correct</th><th scope="col">Total</th><th scope="col">Accuracy</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[column]}>
              <th scope="row">{labelOf ? labelOf(row[column]) : row[column]}</th>
              <td>{row.correct}</td>
              <td>{row.total}</td>
              <td><Meter fraction={row.accuracy} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExamReview({ review, subjectName }: { review: Review; subjectName: string | null }) {
  const { totals, quiz, attempt } = review;
  const aiAnswers = review.questions.filter((question) => question.answerSource === "ai_generated").length;

  return (
    <div className="exam-review">
      <Link className="back-link" href="/exam">← Back to exam mode</Link>

      <div className="quiz-panel quiz-result">
        <p className="eyebrow"><span className="sun-dot" /> EXAM RESULT</p>
        <h1>{quiz.title.replace(/^Exam: /, "")}</h1>
        <p className="welcome-subtitle">
          {[subjectName, attempt.completedAt && `Submitted ${formatDate(attempt.completedAt)}`].filter(Boolean).join(" · ")}
        </p>
        <p className="quiz-score">
          <strong>{totals.percent}%</strong>
          <span>{totals.correct} / {totals.total} correct</span>
        </p>

        <div className="stat-row four exam-tiles">
          <div className="stat-tile is-correct"><strong>{totals.correct}</strong><span>Correct</span></div>
          <div className="stat-tile is-incorrect"><strong>{totals.incorrect}</strong><span>Incorrect</span></div>
          <div className="stat-tile"><strong>{totals.unanswered}</strong><span>Unanswered</span></div>
          <div className="stat-tile">
            <strong>{totals.timeUsedSeconds === null ? "—" : formatDuration(totals.timeUsedSeconds)}</strong>
            <span>
              {totals.timeLimitSeconds === null ? "Time used (no timer)" : `Time used of ${formatDuration(totals.timeLimitSeconds)}`}
              {totals.timeRemainingSeconds !== null && totals.timeRemainingSeconds > 0 && ` · ${formatDuration(totals.timeRemainingSeconds)} left`}
            </span>
          </div>
        </div>

        <p className="exam-summary">
          {totals.answered} of {totals.total} answered
          {totals.accuracy !== null && <> · {percent(totals.accuracy)} of the questions you answered were right</>}
        </p>
        {totals.late && (
          <div className="form-message info" role="status">This exam was submitted after its time ran out, so it was marked from the answers saved before the end.</div>
        )}
        {aiAnswers > 0 && (
          <div className="form-message info" role="status">
            {aiAnswers} of these {aiAnswers === 1 ? "questions was" : "questions were"} marked against an answer worked out by Ari, because the uploaded paper has no answer key for {aiAnswers === 1 ? "it" : "them"}. Each one is labelled below.
          </div>
        )}

        <div className="quiz-actions">
          {review.retryable > 0 && <MistakePractice label={`Retry incorrect questions (${review.retryable})`} retryAttemptId={attempt.id} variant="primary" />}
          <Link className="auth-secondary" href="/exam">New exam</Link>
          <Link className="auth-secondary" href="/performance">Exam readiness</Link>
        </div>
      </div>

      <h2 className="quiz-review-title">Topic breakdown</h2>
      <BreakdownTable caption="Topic" column="topic" rows={review.topics} />

      {(review.types.length > 1 || review.difficulties.length > 0) && (
        <div className="perf-columns exam-columns">
          {review.types.length > 1 && <BreakdownTable caption="Question type" column="type" labelOf={(value) => TYPE_LABELS[value] ?? value} rows={review.types} />}
          {review.difficulties.length > 0 && <BreakdownTable caption="Difficulty (Ari's estimate)" column="difficulty" labelOf={(value) => DIFFICULTY_LABELS[value] ?? value} rows={review.difficulties} />}
        </div>
      )}

      <h2 className="quiz-review-title">Question review</h2>
      <ol className="quiz-review">
        {review.questions.map((question, position) => (
          <li className="quiz-panel" key={question.id}>
            <div className="quiz-review-head">
              <span>
                Question {position + 1}
                {question.number && ` · no. ${question.number} in the paper`}
                {` · ${question.topic}`}
                {question.flagged && " · ⚑ marked for review"}
              </span>
              <span className={`status-badge quiz-badge is-${question.result === "unanswered" ? "partial" : question.result}`}>{RESULT_LABELS[question.result]}</span>
            </div>
            <p className="quiz-question">{question.question}</p>
            {question.type === "multiple_choice" && (
              <ul className="quiz-review-options">
                {question.options.map((option, index) => (
                  <li className={option === question.correctAnswer ? "is-answer" : undefined} key={option}>
                    <span aria-hidden="true">{String.fromCharCode(65 + index)}</span>{option}
                    {option === question.correctAnswer && <span className="visually-hidden"> (correct answer)</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className={`quiz-feedback is-${question.result === "correct" ? "correct" : question.result === "incorrect" ? "incorrect" : "partial"}`}>
              <dl>
                <div><dt>Your answer</dt><dd>{question.answer === null ? "Not answered" : answerText(question.answer)}</dd></div>
                <div><dt>{question.answerSource === "ai_generated" ? "Ari's answer" : "Correct answer"}</dt><dd>{answerText(question.correctAnswer)}</dd></div>
              </dl>
              <AnswerSourceLabel source={question.answerSource} />
              {question.explanation !== NO_EXPLANATION && (
                <p>{question.explanation}{question.explanationSource === "ai_generated" && question.answerSource === "official" && " (explanation by Ari)"}</p>
              )}
              <div className="quiz-feedback-footer">
                <span className="quiz-source">{question.explanation === NO_EXPLANATION && "The paper gives no explanation for this answer."}</span>
                <Link className="link-button" href={question.answerId ? `/tutor?explain=${question.answerId}` : `/tutor?explainQuestion=${question.id}`}>
                  Ask Ari to explain <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
