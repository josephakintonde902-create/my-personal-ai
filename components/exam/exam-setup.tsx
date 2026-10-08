"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { startExamAction } from "@/app/(app)/exam/actions";
import { formatScore, percent } from "@/components/practice/scope-fields";
import type { Difficulty } from "@/lib/ai/practice/types";
import { formatCount, formatDate } from "@/lib/library/format";
import { PAST } from "@/lib/past-questions/config";
import { formatDuration } from "@/lib/past-questions/format";
import type { ExamHome } from "@/lib/past-questions/queries";
import { matchingSummaries } from "@/lib/past-questions/summary";

const DIFFICULTIES: { value: Difficulty; label: string }[] = [{ value: "easy", label: "Easy" }, { value: "medium", label: "Medium" }, { value: "hard", label: "Hard" }];

type Props = ExamHome & {
  // A collection to start with, from /exam?set=<id>.
  initialSetId: string | null;
};

// Sets up an exam simulation and lists the ones already taken. Everything
// shown here is counted from the student's own questions; the questions are
// chosen again on the server when the exam starts.
export function ExamSetup({ subjects, sets, summaries, history, initialSetId }: Props) {
  const router = useRouter();
  const ready = sets.filter((set) => set.status === "ready" && set.answerable > 0);
  const initial = ready.some((set) => set.id === initialSetId) ? `set:${initialSetId}` : "all";
  // "all", "subject:<id>", "set:<id>" or "several".
  const [source, setSource] = useState(initial);
  const [chosen, setChosen] = useState<string[]>([]);
  const [count, setCount] = useState<number | "all">(20);
  const [difficulty, setDifficulty] = useState<Difficulty | "mixed">("mixed");
  const [time, setTime] = useState<string>("30");
  const [custom, setCustom] = useState("90");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const [kind, id] = source.split(":");
  const scopeSets = kind === "set" ? ready.filter((set) => set.id === id) : kind === "subject" ? ready.filter((set) => set.subjectId === id) : kind === "several" ? ready.filter((set) => chosen.includes(set.id)) : ready;
  const setIds = new Set(scopeSets.map((set) => set.id));
  const available = (level: Difficulty | null) => matchingSummaries(summaries, { kind: "exam", setIds, year: null, topic: null, difficulty: level, selection: "random" }).length;
  const total = available(difficulty === "mixed" ? null : difficulty);
  // A difficulty is offered only when enough questions actually carry it.
  const rated = Object.fromEntries(DIFFICULTIES.map(({ value }) => [value, available(value)])) as Record<Difficulty, number>;
  const anyRated = Object.values(rated).some((value) => value >= PAST.minQuestionsPerDifficulty);

  const customMinutes = Number(custom);
  const customValid = Number.isInteger(customMinutes) && customMinutes >= PAST.minCustomMinutes && customMinutes <= PAST.maxCustomMinutes;
  const enough = count === "all" ? total > 0 : total >= count;
  const canStart = !pending && enough && (time !== "custom" || customValid) && (kind !== "several" || chosen.length > 0);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    setPending(true);
    setError(null);

    const result = await startExamAction({
      setIds: kind === "set" ? [id] : kind === "several" ? chosen : [],
      subjectId: kind === "subject" ? id : null,
      count,
      difficulty,
      timeLimitMinutes: time === "none" ? null : time === "custom" ? customMinutes : Number(time),
    });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    // Stay locked until the exam page has replaced this one.
    router.push(`/exam/${result.data.attemptId}`);
  }

  const withSubjects = subjects.filter((subject) => ready.some((set) => set.subjectId === subject.id));

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> PRACTISE UNDER EXAM CONDITIONS</p>
          <h1>Exam mode<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">A timed paper from your own past questions. Nothing is marked or explained until you submit.</p>
        </div>
      </div>

      {ready.length === 0 ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>◴</span><i>·</i></div>
          <strong>{sets.length === 0 ? "No past questions uploaded yet." : "No questions ready for an exam yet."}</strong>
          <p>
            {sets.length === 0
              ? "An exam is made from your own uploaded past questions. Upload a past paper to get started."
              : "An exam needs multiple-choice or true/false questions that have an answer to mark against. Open a collection to see what was read from it."}
          </p>
          <Link className="action-button" href="/past-questions">Go to past questions</Link>
        </div>
      ) : (
        <div className="practice-grid single">
          <form aria-labelledby="exam-form-title" className="practice-card" onSubmit={start}>
            <h2 id="exam-form-title">Set up an exam</h2>
            <p className="practice-card-note">Multiple-choice and true/false questions only, so the whole paper can be marked the moment you submit.</p>

            <div className="field">
              <label htmlFor="exam-source">Questions from</label>
              <select className="field-input" disabled={pending} id="exam-source" onChange={(event) => setSource(event.target.value)} value={source}>
                <option value="all">All my uploaded past questions</option>
                {withSubjects.length > 0 && (
                  <optgroup label="One subject">
                    {withSubjects.map((subject) => <option key={subject.id} value={`subject:${subject.id}`}>{subject.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="One collection">
                  {ready.map((set) => <option key={set.id} value={`set:${set.id}`}>{set.title}</option>)}
                </optgroup>
                {ready.length > 1 && <option value="several">Several collections…</option>}
              </select>
            </div>

            {kind === "several" && (
              <fieldset className="exam-collections">
                <legend className="field-label">Collections to mix</legend>
                {ready.map((set) => (
                  <label key={set.id}>
                    <input
                      checked={chosen.includes(set.id)}
                      disabled={pending}
                      onChange={(event) => setChosen((current) => (event.target.checked ? [...current, set.id] : current.filter((item) => item !== set.id)))}
                      type="checkbox"
                    />
                    <span>{set.title}<em>{subjectNames.get(set.subjectId)}</em></span>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="practice-row">
              <div className="field">
                <label htmlFor="exam-count">Number of questions</label>
                <select className="field-input" disabled={pending} id="exam-count" onChange={(event) => setCount(event.target.value === "all" ? "all" : Number(event.target.value))} value={count}>
                  {PAST.examSizes.map((size) => <option disabled={total < size} key={size} value={size}>{size}{total < size ? " (not enough questions)" : ""}</option>)}
                  <option value="all">All available ({Math.min(total, PAST.maxSessionQuestions)})</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="exam-difficulty">Difficulty</label>
                <select className="field-input" disabled={pending || !anyRated} id="exam-difficulty" onChange={(event) => setDifficulty(event.target.value as Difficulty | "mixed")} value={difficulty}>
                  <option value="mixed">Mixed</option>
                  {DIFFICULTIES.map(({ value, label }) => (
                    <option disabled={rated[value] < PAST.minQuestionsPerDifficulty} key={value} value={value}>{label} ({rated[value]})</option>
                  ))}
                </select>
                <span className="field-hint">{anyRated ? "Difficulty is Ari's estimate, not the examiner's." : "These questions have no difficulty rating, so only Mixed is offered."}</span>
              </div>
            </div>

            <div className="practice-row">
              <div className="field">
                <label htmlFor="exam-time">Time allowed</label>
                <select className="field-input" disabled={pending} id="exam-time" onChange={(event) => setTime(event.target.value)} value={time}>
                  <option value="none">No timer</option>
                  {PAST.examDurations.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {time === "custom" && (
                <div className="field">
                  <label htmlFor="exam-custom">Minutes</label>
                  <input
                    aria-invalid={customValid ? undefined : true}
                    className={`field-input${customValid ? "" : " has-error"}`}
                    disabled={pending}
                    id="exam-custom"
                    inputMode="numeric"
                    max={PAST.maxCustomMinutes}
                    min={PAST.minCustomMinutes}
                    onChange={(event) => setCustom(event.target.value)}
                    type="number"
                    value={custom}
                  />
                  {!customValid && <p className="field-error" role="alert">Enter a whole number from {PAST.minCustomMinutes} to {PAST.maxCustomMinutes}.</p>}
                </div>
              )}
            </div>

            <p className="practice-wait" role="status">
              {total === 0 ? "No questions that can be marked match these choices." : !enough ? `Only ${formatCount(total, "question")} available: choose fewer, or “All available”.` : `${formatCount(total, "question")} available for this exam.`}
            </p>
            {error && <div className="form-message error" role="alert">{error}</div>}

            <button aria-busy={pending} className="auth-submit" disabled={!canStart} type="submit">
              {pending && <span aria-hidden="true" className="spinner" />}
              {pending ? "Preparing your exam…" : "Start exam"}
            </button>
            <p className="practice-wait">The clock starts as soon as the exam opens.</p>
          </form>
        </div>
      )}

      <section aria-labelledby="exam-history-title" className="lower-section">
        <div className="section-heading lower-heading">
          <div><span aria-hidden="true" className="section-icon plan-icon">◴</span><h2 id="exam-history-title">Exam history</h2></div>
          <Link className="text-button" href="/performance">Exam readiness <span aria-hidden="true">→</span></Link>
        </div>
        {history.length === 0 ? (
          <div className="library-empty compact"><strong>No exams yet.</strong><p>Each exam you sit is listed here with its score and time.</p></div>
        ) : (
          <div className="perf-table-wrap">
            <table className="perf-table">
              <thead>
                <tr><th scope="col">Exam</th><th scope="col">Date</th><th scope="col">Subject</th><th scope="col">Questions</th><th scope="col">Score</th><th scope="col">Time</th></tr>
              </thead>
              <tbody>
                {history.map((exam) => (
                  <tr key={exam.attemptId}>
                    <th scope="row"><Link href={`/exam/${exam.attemptId}`}>{exam.title.replace(/^Exam: /, "")}</Link></th>
                    <td>{formatDate(exam.startedAt)}</td>
                    <td>{exam.subjectId ? (subjectNames.get(exam.subjectId) ?? "—") : "Mixed"}</td>
                    <td>{exam.questions}</td>
                    <td>{exam.completedAt && exam.score !== null ? `${percent(exam.score, exam.questions)}% (${formatScore(exam.score, exam.questions)})` : <span className="status-badge">In progress</span>}</td>
                    <td>
                      {exam.timeUsedSeconds === null ? "—" : formatDuration(exam.timeUsedSeconds)}
                      {exam.timeLimitSeconds !== null && ` of ${formatDuration(exam.timeLimitSeconds)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="perf-note">Scores are set when an exam is submitted and can&apos;t be changed afterwards.</p>
      </section>
    </>
  );
}
