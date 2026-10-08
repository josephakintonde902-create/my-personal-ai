"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveExamProgressAction, submitExamAction } from "@/app/(app)/exam/actions";
import { Dialog } from "@/components/ui/dialog";
import type { ExamQuestion } from "@/lib/past-questions/sessions";
import type { ExamState } from "@/lib/past-questions/types";

type Props = {
  attemptId: string;
  title: string;
  questions: ExamQuestion[];
  // Answers and flags already saved on the server (after a refresh).
  initialState: ExamState;
  // Seconds left when the page was rendered, by the server's clock. Null: untimed.
  remainingSeconds: number | null;
};

const SAVE_DELAY_MS = 800;
const WARNINGS = [300, 60];

function clock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// An exam in progress. The browser holds the questions and the student's own
// choices and nothing else: no correct answers, explanations or topics are
// sent until the exam has been submitted and marked on the server.
export function ExamRunner({ attemptId, title, questions, initialState, remainingSeconds }: Props) {
  const router = useRouter();
  const [answers, setAnswers] = useState<ExamState["answers"]>(initialState.answers);
  const [flagged, setFlagged] = useState<string[]>(initialState.flagged);
  const [index, setIndex] = useState(() => {
    const next = questions.findIndex((question) => initialState.answers[question.id] === undefined);
    return next === -1 ? 0 : next;
  });
  const [secondsLeft, setSecondsLeft] = useState(remainingSeconds);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState<"manual" | "timeout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every change; a save records the version it wrote.
  const [version, setVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ answers, flagged });
  const submitted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    latest.current = { answers, flagged };
  }, [answers, flagged]);

  const question = questions[index];
  const answered = questions.filter((item) => answers[item.id] !== undefined).length;
  const unanswered = questions.length - answered;
  const timeUp = secondsLeft !== null && secondsLeft <= 0;

  const submit = useCallback(
    async (reason: "manual" | "timeout") => {
      if (submitted.current) return;
      submitted.current = true;
      setSubmitting(reason);
      setError(null);
      const result = await submitExamAction({ attemptId, ...latest.current });
      if (!result.ok) {
        // Nothing is lost: the choices are still on screen and can be sent again.
        submitted.current = false;
        setSubmitting(null);
        setConfirming(false);
        setError(result.error);
        return;
      }
      // The page now renders the marked exam.
      router.refresh();
    },
    [attemptId, router],
  );

  // The countdown runs from the time the server said was left, so a wrong
  // clock on this device cannot lengthen the exam. The server decides in any
  // case: a late submission is marked from the answers saved in time.
  useEffect(() => {
    if (remainingSeconds === null) return;
    const deadline = Date.now() + remainingSeconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (WARNINGS.includes(left)) setAnnouncement(`${left / 60} ${left === 60 ? "minute" : "minutes"} remaining.`);
      if (left === 0) void submit("timeout");
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [remainingSeconds, submit]);

  // Save a moment after each change, so a refresh or a dropped connection
  // loses nothing.
  useEffect(() => {
    if (version === savedVersion || submitted.current) return;
    const timer = window.setTimeout(async () => {
      const writing = version;
      const result = await saveExamProgressAction({ attemptId, ...latest.current });
      setSaveFailed(!result.ok || !result.data.saved);
      if (result.ok && result.data.saved) setSavedVersion(writing);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [version, savedVersion, attemptId]);

  // Changes still waiting for that moment are sent at once when the page is
  // hidden, closed or left, so an answer given just before a refresh, an app
  // switch on a phone, or a tap on another page is not lost.
  const unsaved = useRef(false);
  useEffect(() => {
    unsaved.current = version !== savedVersion;
  }, [version, savedVersion]);
  useEffect(() => {
    const flush = () => {
      if (!unsaved.current || submitted.current) return;
      unsaved.current = false;
      void saveExamProgressAction({ attemptId, ...latest.current });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [attemptId]);

  // Leaving by accident should not end an exam.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!submitted.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [index]);

  const change = () => setVersion((current) => current + 1);
  const choose = (value: number | boolean) => {
    setAnswers((current) => ({ ...current, [question.id]: value }));
    change();
  };
  const clear = () => {
    setAnswers((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
    change();
  };
  const toggleFlag = () => {
    setFlagged((current) => (current.includes(question.id) ? current.filter((id) => id !== question.id) : [...current, question.id]));
    change();
  };

  const isFlagged = flagged.includes(question.id);
  const locked = submitting !== null || timeUp;
  const current = answers[question.id];
  const trueFalse: [string, boolean][] = [["True", true], ["False", false]];
  const saveStatus = saveFailed ? "Not saved yet — check your connection" : version === savedVersion ? "All answers saved" : "Saving…";

  return (
    <div className="exam-runner exam-active">
      <header className="exam-bar">
        <div className="exam-bar-copy">
          <strong>{title}</strong>
          <span>{answered} of {questions.length} answered · {saveStatus}</span>
        </div>
        {secondsLeft !== null && (
          <div className={`exam-timer${secondsLeft <= 300 ? " is-low" : ""}`} role="timer" aria-label={`Time remaining: ${clock(secondsLeft)}`}>
            <span aria-hidden="true">◴</span>{clock(secondsLeft)}
          </div>
        )}
        <button className="action-button exam-submit" disabled={locked} onClick={() => setConfirming(true)} type="button">Submit exam</button>
      </header>
      <div className="exam-progress progress-track" aria-hidden="true"><span style={{ width: `${(answered / questions.length) * 100}%` }} /></div>
      <p aria-live="polite" className="visually-hidden">{announcement}</p>

      {submitting === "timeout" && <div className="form-message info" role="status">Time&apos;s up. Submitting your exam…</div>}
      {error && (
        <div className="form-message error" role="alert">
          {error} <button className="link-button" onClick={() => void submit(timeUp ? "timeout" : "manual")} type="button">Submit again</button>
        </div>
      )}

      <div className="exam-layout">
        <section className="quiz-panel exam-question" aria-labelledby="exam-question-heading">
          <div className="quiz-review-head">
            <h1 className="quiz-count" id="exam-question-heading" ref={heading} tabIndex={-1}>Question {index + 1} of {questions.length}</h1>
            <button aria-pressed={isFlagged} className={`icon-button exam-flag${isFlagged ? " is-on" : ""}`} disabled={locked} onClick={toggleFlag} type="button">
              <span aria-hidden="true">⚑</span> {isFlagged ? "Marked for review" : "Mark for review"}
            </button>
          </div>

          <fieldset className="quiz-options" disabled={locked}>
            <legend className="quiz-question">{question.question}</legend>
            {question.type === "multiple_choice"
              ? question.options.map((option, optionIndex) => (
                  <label className={`quiz-option${current === optionIndex ? " is-picked" : ""}`} key={option}>
                    <input checked={current === optionIndex} name={`answer-${question.id}`} onChange={() => choose(optionIndex)} type="radio" />
                    <span aria-hidden="true" className="quiz-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
                    <span>{option}</span>
                  </label>
                ))
              : trueFalse.map(([label, value]) => (
                  <label className={`quiz-option${current === value ? " is-picked" : ""}`} key={label}>
                    <input checked={current === value} name={`answer-${question.id}`} onChange={() => choose(value)} type="radio" />
                    <span>{label}</span>
                  </label>
                ))}
          </fieldset>

          <div className="exam-nav">
            <button className="auth-secondary" disabled={index === 0 || locked} onClick={() => setIndex(index - 1)} type="button">← Previous</button>
            <button className="link-button" disabled={current === undefined || locked} onClick={clear} type="button">Clear answer</button>
            {index < questions.length - 1 ? (
              <button className="auth-submit" disabled={locked} onClick={() => setIndex(index + 1)} type="button">Next →</button>
            ) : (
              <button className="auth-submit" disabled={locked} onClick={() => setConfirming(true)} type="button">Finish</button>
            )}
          </div>
        </section>

        <nav className="exam-map" aria-label="All questions">
          <h2>Questions</h2>
          <ol>
            {questions.map((item, position) => {
              const done = answers[item.id] !== undefined;
              const flag = flagged.includes(item.id);
              return (
                <li key={item.id}>
                  <button
                    aria-current={position === index ? "step" : undefined}
                    aria-label={`Question ${position + 1}: ${done ? "answered" : "not answered"}${flag ? ", marked for review" : ""}`}
                    className={`exam-map-item${done ? " is-answered" : ""}${flag ? " is-flagged" : ""}${position === index ? " is-current" : ""}`}
                    disabled={locked}
                    onClick={() => setIndex(position)}
                    type="button"
                  >
                    {position + 1}
                    {flag && <span aria-hidden="true">⚑</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          <ul className="exam-legend" aria-hidden="true">
            <li><span className="exam-map-item is-answered" />Answered</li>
            <li><span className="exam-map-item" />Not answered</li>
            <li><span className="exam-map-item is-flagged"><span>⚑</span></span>Marked for review</li>
          </ul>
        </nav>
      </div>

      {confirming && (
        <Dialog busy={submitting !== null} onClose={() => setConfirming(false)} title="Submit your exam?">
          <div className="dialog-body">
            <p>You have answered <strong>{answered} of {questions.length}</strong> questions.</p>
            {unanswered > 0 && <p>{unanswered} {unanswered === 1 ? "question is" : "questions are"} unanswered and will score nothing.</p>}
            {flagged.length > 0 && <p>{flagged.length} {flagged.length === 1 ? "question is" : "questions are"} still marked for review.</p>}
            <p>Once submitted, your answers can&apos;t be changed.</p>
          </div>
          <div className="dialog-actions">
            <button className="auth-secondary" disabled={submitting !== null} onClick={() => setConfirming(false)} type="button">Keep working</button>
            <button aria-busy={submitting !== null} className="auth-submit" disabled={submitting !== null} onClick={() => void submit("manual")} type="button">
              {submitting !== null && <span aria-hidden="true" className="spinner" />}
              {submitting !== null ? "Marking…" : "Submit exam"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
