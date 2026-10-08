"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { formatScore, percent } from "@/components/practice/scope-fields";
import { formatCount, formatDate } from "@/lib/library/format";
import type { PastSelection } from "@/lib/past-questions/config";
import type { PastQuestionsPage, SetListItem } from "@/lib/past-questions/queries";
import { matchingSummaries } from "@/lib/past-questions/summary";
import { PastQuestionUpload } from "./past-question-upload";
import { PracticeDialog } from "./practice-dialog";

// How often the page re-checks papers that are still being read, and for how
// long before it stops asking.
const POLL_INTERVAL_MS = 4000;
const POLL_LIMIT_MS = 6 * 60_000;

export const SET_STATUS_LABELS = { pending: "Waiting to be read", processing: "Reading…", ready: "Ready", failed: "Couldn't be read" };

// "Anatomy — 2022", "Anatomy — 2021–2025", or just the subject.
export function setHeading(set: SetListItem, subjectName: string) {
  const years = set.years.length > 1 ? `${set.years[0]}–${set.years[set.years.length - 1]}` : (set.years[0] ?? set.year);
  return [subjectName, years].filter(Boolean).join(" — ");
}

type PracticeTarget = { scope: string; setIds: string[] | null; selection?: PastSelection };

export function PastQuestionsView({ subjects, sets, summaries, frequentTopics, sessions, search }: PastQuestionsPage) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [practising, setPractising] = useState<PracticeTarget | null>(null);
  const [subjectId, setSubjectId] = useState("");
  const [year, setYear] = useState("");
  const [examType, setExamType] = useState("");

  const subjectNames = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
  const setTitles = new Map(sets.map((set) => [set.id, set.title]));
  const years = [...new Set(sets.flatMap((set) => (set.years.length ? set.years : set.year ? [set.year] : [])))].sort((a, b) => b - a);
  const examTypes = [...new Set(sets.map((set) => set.examType).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));

  const visible = sets
    .filter((set) => !subjectId || set.subjectId === subjectId)
    .filter((set) => !year || set.years.includes(Number(year)) || set.year === Number(year))
    .filter((set) => !examType || set.examType === examType);

  const reading = sets.some((set) => (set.status === "pending" || set.status === "processing") && !set.stale);
  useEffect(() => {
    if (!reading) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) window.clearInterval(timer);
      else router.refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reading, router]);

  const count = (selection: PastSelection) => matchingSummaries(summaries, { kind: "practice", setIds: null, year: null, topic: null, difficulty: null, selection }).length;
  const practisable = count("all");
  const mistakes = count("missed");
  const untried = count("unanswered");
  const all = (selection: PastSelection): PracticeTarget => ({ scope: "All your past questions", setIds: null, selection });

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> LEARN FROM REAL EXAMS</p>
          <h1>Past questions<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Upload past papers, practise them, and see which topics come up most.</p>
        </div>
        {sets.length > 0 && (
          <button className="action-button" onClick={() => setUploading(true)} type="button"><span aria-hidden="true">↑</span> Upload past questions</button>
        )}
      </div>

      {sets.length === 0 ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>❖</span><i>·</i></div>
          <strong>No past questions yet.</strong>
          <p>Upload a past paper as a PDF, Word, PowerPoint or text file. Ari reads the questions out of it so you can practise them and sit timed exams.</p>
          <button className="action-button" onClick={() => setUploading(true)} type="button"><span aria-hidden="true">↑</span> Upload past questions</button>
        </div>
      ) : (
        <>
          {practisable > 0 && (
            <div className="past-shortcuts" role="group" aria-label="Start practising">
              <button className="past-shortcut" onClick={() => setPractising(all("random"))} type="button">
                <strong>Practise</strong><span>{formatCount(practisable, "question")} ready</span>
              </button>
              <button className="past-shortcut" disabled={mistakes === 0} onClick={() => setPractising(all("missed"))} type="button">
                <strong>Practise my mistakes</strong><span>{mistakes === 0 ? "None to retry right now" : `${formatCount(mistakes, "question")} to retry`}</span>
              </button>
              <button className="past-shortcut" disabled={untried === 0} onClick={() => setPractising(all("unanswered"))} type="button">
                <strong>Try new questions</strong><span>{untried === 0 ? "You have tried them all" : `${formatCount(untried, "question")} not tried yet`}</span>
              </button>
              <Link className="past-shortcut" href="/exam"><strong>Sit an exam</strong><span>Timed, marked at the end</span></Link>
            </div>
          )}

          <form action="/past-questions" className="past-search" role="search">
            <label className="visually-hidden" htmlFor="past-search">Search your past questions</label>
            <input className="field-input" defaultValue={search?.query ?? ""} id="past-search" maxLength={120} name="q" placeholder="Search the wording of your past questions" type="search" />
            <button className="auth-secondary compact" type="submit">Search</button>
            {search && <Link className="link-button" href="/past-questions">Clear</Link>}
          </form>

          {search && (
            <section aria-labelledby="past-results" className="lower-section">
              <div className="section-heading lower-heading"><div><h2 id="past-results">{search.results.length === 0 ? "No questions found" : `${formatCount(search.results.length, "question")} found`} for “{search.query}”</h2></div></div>
              {search.results.length === 0 ? (
                <p className="perf-note">Nothing in your past questions contains those words. Try fewer or different words.</p>
              ) : (
                <ul className="past-results">
                  {search.results.map((question) => (
                    <li key={question.id}>
                      <Link href={`/past-questions/${question.setId}#q-${question.id}`}>
                        <span>{question.question}</span>
                        <em>{[setTitles.get(question.setId), question.number && `Question ${question.number}`, question.year, question.topic].filter(Boolean).join(" · ")}</em>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section aria-labelledby="past-collections" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon library-icon">❖</span><h2 id="past-collections">Your collections</h2></div>
            </div>
            <div className="filter-bar past-filters">
              <select aria-label="Filter by subject" className="field-input" onChange={(event) => setSubjectId(event.target.value)} value={subjectId}>
                <option value="">All subjects</option>
                {subjects.filter((subject) => sets.some((set) => set.subjectId === subject.id)).map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
              </select>
              <select aria-label="Filter by year" className="field-input" disabled={years.length === 0} onChange={(event) => setYear(event.target.value)} value={year}>
                <option value="">{years.length === 0 ? "No years recorded" : "All years"}</option>
                {years.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select aria-label="Filter by exam" className="field-input" disabled={examTypes.length === 0} onChange={(event) => setExamType(event.target.value)} value={examType}>
                <option value="">{examTypes.length === 0 ? "No exam types recorded" : "All exams"}</option>
                {examTypes.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>

            {visible.length === 0 ? (
              <div className="library-empty compact"><strong>No collections match these filters.</strong><p>Change or clear the filters to see the rest.</p></div>
            ) : (
              <ul className="past-grid">
                {visible.map((set) => {
                  const ready = set.status === "ready";
                  return (
                    <li className="past-card" key={set.id}>
                      <Link className="past-card-link" href={`/past-questions/${set.id}`}>
                        <span className="past-card-top">
                          <span className={`file-chip type-${set.fileExtension}`}>{set.fileExtension.toUpperCase()}</span>
                          <span className={`status-badge status-${set.stale ? "failed" : set.status}`}>{set.stale ? "Stopped" : SET_STATUS_LABELS[set.status]}</span>
                        </span>
                        <strong>{set.title}</strong>
                        <span className="past-card-meta">{setHeading(set, subjectNames.get(set.subjectId) ?? "Subject")}</span>
                        {ready && <span className="past-card-count">{formatCount(set.questions, "Question")}</span>}
                        <span className="past-card-meta">
                          {[set.examType, set.institution, set.courseCode].filter(Boolean).join(" · ") || (ready ? " " : "")}
                        </span>
                        {ready && set.questions > 0 && (
                          <span className="past-card-note">
                            {set.answerable === 0 ? "No answers to mark against yet" : `${set.answerable} can be marked${set.official < set.answerable ? ` (${set.answerable - set.official} with Ari's answers)` : ""}`}
                          </span>
                        )}
                        {ready && set.questions === 0 && <span className="past-card-note">No separate questions could be read. The text is kept as it was.</span>}
                        {set.status === "failed" && <span className="past-card-note error">{set.error ?? "This paper couldn't be read."}</span>}
                      </Link>
                      <div className="past-card-actions">
                        <button className="icon-button primary" disabled={set.answerable === 0} onClick={() => setPractising({ scope: set.title, setIds: [set.id] })} type="button">Practice</button>
                        {set.answerable === 0 ? <span className="icon-button is-disabled" aria-disabled="true">Exam</span> : <Link className="icon-button" href={`/exam?set=${set.id}`}>Exam</Link>}
                        <Link className="icon-button" href={`/past-questions/${set.id}`}>Open</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="past-frequent" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon plan-icon">↻</span><h2 id="past-frequent">Frequently tested</h2></div>
            </div>
            {frequentTopics.length === 0 ? (
              <p className="perf-note">Topics appear here once Ari has labelled the questions in your papers. Open a collection and choose “Analyse with Ari” if it hasn&apos;t happened yet.</p>
            ) : (
              <>
                <ol className="past-topics">
                  {frequentTopics.map((topic) => (
                    <li key={`${topic.subjectName}|${topic.topic}`}>
                      <span><strong>{topic.topic}</strong><em>{topic.subjectName}{topic.years.length > 0 && ` · ${topic.years.join(", ")}`}</em></span>
                      <span className="past-topic-count">{formatCount(topic.questions, "question")}</span>
                    </li>
                  ))}
                </ol>
                <p className="perf-note">Frequently tested in your uploaded past questions. This counts what you have uploaded; it is not a prediction of what a future exam will contain.</p>
              </>
            )}
          </section>

          {sessions.length > 0 && (
            <section aria-labelledby="past-sessions" className="lower-section">
              <div className="section-heading lower-heading">
                <div><span aria-hidden="true" className="section-icon plan-icon">✓</span><h2 id="past-sessions">Recent practice</h2></div>
                <Link className="text-button" href="/exam">Exam history <span aria-hidden="true">→</span></Link>
              </div>
              <ul className="practice-list">
                {sessions.map((session) => (
                  <li className="practice-item" key={session.attemptId ?? session.quizId}>
                    <Link className="practice-item-link" href={`/quizzes/${session.quizId}`}>
                      <span className="practice-item-copy">
                        <strong>{session.title}</strong>
                        <span>{formatCount(session.questions, "question")}<i aria-hidden="true">·</i>{formatDate(session.startedAt)}</span>
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
        </>
      )}

      {uploading && <PastQuestionUpload onClose={() => setUploading(false)} onUploaded={() => router.refresh()} subjects={subjects} />}
      {practising && <PracticeDialog initialSelection={practising.selection} onClose={() => setPractising(null)} scope={practising.scope} setIds={practising.setIds} summaries={summaries} />}
    </>
  );
}
