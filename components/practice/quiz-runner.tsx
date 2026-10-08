"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { answerQuestionAction, completeAttemptAction, startAttemptAction } from "@/app/(app)/quizzes/actions";
import { AnswerSourceLabel } from "@/components/past-questions/answer-source";
import { MistakePractice } from "@/components/past-questions/mistake-practice";
import { PRACTICE } from "@/lib/ai/practice/config";
import { answerText } from "@/lib/ai/practice/explain";
import type { AnswerFeedback, PublicQuestion, Quiz, QuizAttempt, QuizSummary } from "@/lib/ai/practice/types";
import { sourceLabel } from "@/lib/ai/tutor/citations";
import { formatScore, percent } from "./scope-fields";

type Props = {
  quiz: Quiz;
  questions: PublicQuestion[];
  // The most recent attempt, or null if the quiz has not been started.
  attempt: QuizAttempt | null;
  feedback: AnswerFeedback[];
  summary: QuizSummary | null;
  subjectName: string | null;
};

const RESULT_HEADINGS = { correct: "Correct.", partial: "Partly right.", incorrect: "Not quite." };
const RESULT_LABELS = { correct: "Correct", partial: "Partly right", incorrect: "Incorrect" };

function indexById<T extends { questionId: string }>(items: T[]) {
  return new Map(items.map((item) => [item.questionId, item]));
}

// The explanation shown once a question is answered, during the quiz and
// again in the review at the end.
function Feedback({ feedback, heading }: { feedback: AnswerFeedback; heading: boolean }) {
  const unanswered = feedback.answer === "";
  return (
    <div className={`quiz-feedback is-${feedback.result}`}>
      {heading && <strong className="quiz-feedback-heading">{RESULT_HEADINGS[feedback.result]}</strong>}
      <dl>
        <div><dt>Your answer</dt><dd>{unanswered ? "Not answered" : answerText(feedback.answer)}</dd></div>
        {feedback.result !== "correct" && <div><dt>{feedback.answerSource === "ai_generated" ? "Ari's answer" : "Correct answer"}</dt><dd>{answerText(feedback.correctAnswer)}</dd></div>}
      </dl>
      {/* Past-paper questions say whose answer they were marked against. */}
      {feedback.answerSource && <AnswerSourceLabel source={feedback.answerSource} />}
      {feedback.feedback && <p>{feedback.feedback}</p>}
      <p>{feedback.explanation}</p>
      <div className="quiz-feedback-footer">
        {feedback.source && <span className="quiz-source"><span>Source</span>{sourceLabel(feedback.source)}</span>}
        {feedback.answerId && (
          <Link className="link-button" href={`/tutor?explain=${feedback.answerId}`}>
            Ask Ari to explain <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>
    </div>
  );
}

export function QuizRunner({ quiz, questions, subjectName, ...props }: Props) {
  const [attempt, setAttempt] = useState(props.attempt);
  const [feedback, setFeedback] = useState(() => indexById(props.feedback));
  const [summary, setSummary] = useState(props.summary);
  // Where the student is: the first question not yet answered.
  const [index, setIndex] = useState(() => {
    const answered = new Set(props.feedback.map((item) => item.questionId));
    const next = questions.findIndex((question) => !answered.has(question.id));
    return next === -1 ? questions.length - 1 : next;
  });
  const [choice, setChoice] = useState<number | boolean | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<"start" | "answer" | "finish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedbackRegion = useRef<HTMLDivElement>(null);

  const question = questions[index];
  const current = question ? feedback.get(question.id) : undefined;
  const finished = Boolean(summary);
  const isLast = index === questions.length - 1;

  // Move keyboard and screen reader focus to what just changed: the new
  // question, or the feedback on the answer just given.
  useEffect(() => {
    if (attempt && !finished) heading.current?.focus();
  }, [index, attempt, finished]);
  useEffect(() => {
    if (current) feedbackRegion.current?.focus();
  }, [current]);

  async function start() {
    if (pending) return;
    setPending("start");
    setError(null);
    const result = await startAttemptAction(quiz.id);
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAttempt(result.data.attempt);
    setFeedback(new Map());
    setSummary(null);
    setIndex(0);
    setChoice(null);
    setText("");
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!attempt || pending || current) return;
    const answer = question.type === "short_answer" ? text.trim() : choice;
    if (answer === null || answer === "") return;

    setPending("answer");
    setError(null);
    const result = await answerQuestionAction({ attemptId: attempt.id, questionId: question.id, answer });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFeedback((map) => new Map(map).set(question.id, result.data));
  }

  async function next() {
    if (!attempt || pending) return;
    setError(null);
    if (!isLast) {
      setIndex(index + 1);
      setChoice(null);
      setText("");
      return;
    }

    setPending("finish");
    const result = await completeAttemptAction(attempt.id);
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setFeedback(indexById(result.data.review));
    setSummary({ attempt: result.data.attempt, weakAreas: result.data.weakAreas });
    window.scrollTo({ top: 0 });
  }

  // A session made from uploaded past questions is taken here like any
  // other quiz; only its labels and the way back differ.
  const past = quiz.mode === "past_practice";
  const practice = past || quiz.mode === "practice";
  const back = past ? { href: "/past-questions", label: "Back to past questions" } : { href: "/quizzes", label: "Back to quizzes" };
  const meta = [subjectName ?? "All subjects", `${questions.length} questions`, past ? "Past questions" : practice ? "Practice" : null].filter(Boolean).join(" · ");

  // ------------------------------------------------------------- not started
  if (!attempt) {
    return (
      <div className="quiz-shell">
        <Link className="back-link" href={back.href}>← {back.label}</Link>
        <div className="quiz-panel quiz-intro">
          <p className="eyebrow"><span className="sun-dot" /> {past ? "PAST QUESTIONS" : practice ? "PRACTICE" : "QUIZ"}</p>
          <h1>{quiz.title}</h1>
          <p className="welcome-subtitle">{meta}</p>
          <p>You&apos;ll see one question at a time. After each answer, {past ? "you'll see whether it was right, the answer it was marked against and where that answer came from." : "Ari tells you whether it was right and why."}</p>
          {error && <div className="form-message error" role="alert">{error}</div>}
          <button aria-busy={pending === "start"} className="auth-submit" disabled={Boolean(pending)} onClick={start} type="button">
            {pending === "start" && <span aria-hidden="true" className="spinner" />}
            {pending === "start" ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- finished
  if (summary) {
    const { score, totalQuestions } = summary.attempt;
    const points = score ?? 0;
    return (
      <div className="quiz-shell">
        <Link className="back-link" href={back.href}>← {back.label}</Link>
        <div className="quiz-panel quiz-result">
          <p className="eyebrow"><span className="sun-dot" /> {quiz.title}</p>
          <h1>{practice ? "Practice complete" : "Quiz complete"}</h1>
          <p className="quiz-score">
            <strong>{formatScore(points, totalQuestions)}</strong>
            <span>{percent(points, totalQuestions)}%</span>
          </p>

          {summary.weakAreas.length > 0 ? (
            <div className="quiz-weak">
              <h2>Worth another look, from this quiz</h2>
              <ul>
                {summary.weakAreas.map((area) => (
                  <li key={area.topic}><strong>{area.topic}</strong><span>{area.missed} of {area.total} missed</span></li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="quiz-weak-none">You got everything right. Nothing stood out as a weak spot in this quiz.</p>
          )}

          {error && <div className="form-message error" role="alert">{error}</div>}
          <div className="quiz-actions">
            <button aria-busy={pending === "start"} className="auth-submit" disabled={Boolean(pending)} onClick={start} type="button">
              {pending === "start" && <span aria-hidden="true" className="spinner" />}
              {pending === "start" ? "Starting…" : "Try again"}
            </button>
            {past && summary.weakAreas.length > 0 && <MistakePractice label="Retry incorrect questions" retryAttemptId={summary.attempt.id} />}
            <Link className="auth-secondary" href={back.href}>{back.label}</Link>
          </div>
        </div>

        <h2 className="quiz-review-title">Review</h2>
        <ol className="quiz-review">
          {questions.map((item, position) => {
            const result = feedback.get(item.id);
            return (
              <li className="quiz-panel" key={item.id}>
                <div className="quiz-review-head">
                  <span>Question {position + 1}</span>
                  {result && <span className={`status-badge quiz-badge is-${result.result}`}>{RESULT_LABELS[result.result]}</span>}
                </div>
                <p className="quiz-question">{item.question}</p>
                {item.type === "multiple_choice" && (
                  <ul className="quiz-review-options">
                    {item.options.map((option, optionIndex) => (
                      <li className={result && option === result.correctAnswer ? "is-answer" : undefined} key={option}>
                        <span aria-hidden="true">{String.fromCharCode(65 + optionIndex)}</span>{option}
                        {result && option === result.correctAnswer && <span className="visually-hidden"> (correct answer)</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {result && <Feedback feedback={result} heading={false} />}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  // ------------------------------------------------------------- in progress
  const answered = Boolean(current);
  const hasAnswer = question.type === "short_answer" ? text.trim().length > 0 : choice !== null;
  const trueFalse: [string, boolean][] = [["True", true], ["False", false]];

  return (
    <div className="quiz-shell">
      <Link className="back-link" href={back.href}>← {back.label}</Link>

      <div className="quiz-progress">
        <span>{quiz.title}</span>
        <div aria-hidden="true" className="progress-track"><span style={{ width: `${((index + (answered ? 1 : 0)) / questions.length) * 100}%` }} /></div>
      </div>

      <form className="quiz-panel" onSubmit={check}>
        <h1 className="quiz-count" ref={heading} tabIndex={-1}>Question {index + 1} of {questions.length}</h1>

        {question.type === "short_answer" ? (
          <div className="quiz-short">
            <label className="quiz-question" htmlFor="quiz-answer">{question.question}</label>
            <textarea
              className="field-input field-textarea"
              disabled={answered || pending === "answer"}
              id="quiz-answer"
              maxLength={PRACTICE.maxShortAnswerLength}
              onChange={(event) => setText(event.target.value)}
              placeholder="Answer in your own words. A sentence or two is enough."
              rows={4}
              value={answered ? answerText(current!.answer) : text}
            />
          </div>
        ) : (
          <fieldset className="quiz-options" disabled={answered || pending === "answer"}>
            <legend className="quiz-question">{question.question}</legend>
            {question.type === "multiple_choice"
              ? question.options.map((option, optionIndex) => {
                  const picked = answered ? current!.answer === option : choice === optionIndex;
                  const state = answered ? (option === current!.correctAnswer ? " is-answer" : picked ? " is-wrong" : "") : "";
                  return (
                    <label className={`quiz-option${picked ? " is-picked" : ""}${state}`} key={option}>
                      <input checked={picked} name="answer" onChange={() => setChoice(optionIndex)} type="radio" />
                      <span aria-hidden="true" className="quiz-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
                      <span>{option}</span>
                    </label>
                  );
                })
              : trueFalse.map(([label, value]) => {
                  const picked = answered ? current!.answer === value : choice === value;
                  const state = answered ? (value === current!.correctAnswer ? " is-answer" : picked ? " is-wrong" : "") : "";
                  return (
                    <label className={`quiz-option${picked ? " is-picked" : ""}${state}`} key={label}>
                      <input checked={picked} name="answer" onChange={() => setChoice(value)} type="radio" />
                      <span>{label}</span>
                    </label>
                  );
                })}
          </fieldset>
        )}

        {error && <div className="form-message error" role="alert">{error}</div>}

        {current ? (
          <>
            <div aria-label="Feedback on your answer" ref={feedbackRegion} role="status" tabIndex={-1}>
              <Feedback feedback={current} heading />
            </div>
            <div className="quiz-actions">
              <button aria-busy={pending === "finish"} className="auth-submit" disabled={Boolean(pending)} onClick={next} type="button">
                {pending === "finish" && <span aria-hidden="true" className="spinner" />}
                {pending === "finish" ? "Adding up your score…" : isLast ? "See results" : "Next question"}
              </button>
            </div>
          </>
        ) : (
          <div className="quiz-actions">
            <button aria-busy={pending === "answer"} className="auth-submit" disabled={!hasAnswer || Boolean(pending)} type="submit">
              {pending === "answer" && <span aria-hidden="true" className="spinner" />}
              {pending === "answer" ? (question.type === "short_answer" ? "Ari is checking…" : "Checking…") : "Check answer"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
