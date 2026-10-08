import Link from "next/link";
import type { QuestionType } from "@/lib/ai/practice/types";
import { formatDate } from "@/lib/library/format";
import { levelOf, type Tally, type Trend } from "@/lib/performance/compute";
import { LEVEL_LABELS, PERFORMANCE, type Level } from "@/lib/performance/config";
import type { PerformanceReport } from "@/lib/performance/queries";
import { MistakePractice } from "@/components/past-questions/mistake-practice";
import { READINESS } from "@/lib/performance/config";
import type { Readiness } from "@/lib/performance/readiness";

// The performance page. Everything here is rendered on the server from the
// student's own records; there is no client-side code and nothing is
// estimated or generated.

const LEVEL_ICONS: Record<Level, string> = { strong: "✓", developing: "◐", needs_review: "!" };
const TYPE_LABELS: Record<QuestionType, string> = { multiple_choice: "Multiple choice", true_false: "True / false", short_answer: "Short answer" };
const DIFFICULTY_LABELS = { easy: "Easy", medium: "Medium", hard: "Hard" };
const TREND_LABELS = { improving: "Improving", stable: "Stable", declining: "Declining", insufficient: "Not enough data" };
const TREND_ICONS = { improving: "↗", stable: "→", declining: "↘", insufficient: "·" };

const number = new Intl.NumberFormat("en-GB");
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const score = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

// A level always comes with an icon and a word, never colour alone.
function LevelBadge({ level }: { level: Level | null }) {
  if (!level) return <span className="perf-badge is-none">Not enough data</span>;
  return (
    <span className={`perf-badge is-${level}`}>
      <span aria-hidden="true">{LEVEL_ICONS[level]}</span>
      {LEVEL_LABELS[level]}
    </span>
  );
}

function TrendLabel({ trend }: { trend: Trend }) {
  return (
    <span className={`perf-trend is-${trend.direction}`}>
      <span aria-hidden="true">{TREND_ICONS[trend.direction]}</span>
      {TREND_LABELS[trend.direction]}
    </span>
  );
}

// Accuracy as a bar with its figure beside it. The bar's colour follows the
// level, and stays neutral while there is too little to judge.
function Accuracy({ tally, level = levelOf(tally) }: { tally: Tally; level?: Level | null }) {
  if (tally.accuracy === null) return <span className="perf-muted">—</span>;
  return (
    <span className="perf-accuracy">
      <span aria-hidden="true" className={`perf-meter is-${level ?? "none"}`}>
        <span style={{ width: `${Math.max(tally.accuracy * 100, 2)}%` }} />
      </span>
      <strong>{percent(tally.accuracy)}</strong>
    </span>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="perf-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <em>{note}</em>}
    </div>
  );
}

// Exam readiness: one figure, shown together with everything it was made
// from, so it can always be checked against the student's own numbers. The
// wording describes practice so far and never predicts a result.
function ReadinessSection({ readiness }: { readiness: Readiness }) {
  const { score, status, trend, exams, pastQuestions } = readiness;
  return (
    <section aria-labelledby="perf-readiness" className="lower-section">
      <div className="section-heading lower-heading">
        <div><span aria-hidden="true" className="section-icon plan-icon">◴</span><h2 id="perf-readiness">Exam readiness</h2></div>
        <Link className="text-button" href="/exam">Exam mode <span aria-hidden="true">→</span></Link>
      </div>

      <div className="perf-overview readiness">
        <div className="perf-hero">
          <span>Exam readiness</span>
          <strong>{score === null ? "—" : `${score}%`}</strong>
          <LevelBadge level={status} />
          <p>{readiness.recommendation}</p>
        </div>

        <div className="perf-card readiness-parts">
          <h3>What this is made of</h3>
          <ul className="perf-rows">
            {readiness.parts.map((part) => (
              <li key={part.key}>
                <span>{part.label}</span>
                {part.value === null ? <span className="perf-muted">Not counted yet</span> : <Accuracy level={null} tally={{ attempted: 1, correct: 0, partial: 0, incorrect: 0, accuracy: part.value }} />}
                <em>{part.value === null ? part.detail : `${part.detail} · ${Math.round(part.share * 100)}% of the score`}</em>
              </li>
            ))}
          </ul>
          <p className="perf-note">
            {score === null
              ? `A score appears once you have answered at least ${READINESS.minAnswers} questions.`
              : `A weighted average of the parts above${readiness.penalty > 0 ? `, less ${readiness.penalty} points for topics that need review` : ""}. ${READINESS.strongScore}% and above is Strong, ${READINESS.developingScore}% and above Developing. It describes your practice so far; it is not a prediction of an exam result.`}
          </p>
        </div>
      </div>

      <div className="perf-tiles readiness-tiles">
        <Tile label="Exam practice" value={`${exams.completed} ${exams.completed === 1 ? "simulation" : "simulations"} completed`} note={exams.latestPercent === null ? "Sit one in Exam mode" : `Latest ${exams.latestPercent}% · average ${exams.averagePercent}%`} />
        <Tile label="Past question performance" value={pastQuestions.accuracy === null ? "—" : percent(pastQuestions.accuracy)} note={pastQuestions.answered === 0 ? "No past questions answered yet" : `across ${number.format(pastQuestions.answered)} ${pastQuestions.answered === 1 ? "question" : "questions"}`} />
        <Tile
          label="Recent trend"
          value={trend.change === null ? "—" : `${trend.change > 0 ? "+" : ""}${trend.change}%`}
          note={trend.change === null ? `Needs answers in the last ${trend.days} days and the ${trend.days} before` : `compared with your previous ${trend.days} days`}
        />
      </div>

      <div className="perf-columns">
        <div className="perf-card">
          <h3>Strong areas</h3>
          {readiness.strongAreas.length > 0 ? <ul className="readiness-areas">{readiness.strongAreas.map((area) => <li key={area}>{area}</li>)}</ul> : <p className="perf-note">Nothing has reached {READINESS.strongScore}% with enough answers yet.</p>}
        </div>
        <div className="perf-card">
          <h3>Areas to review</h3>
          {readiness.reviewAreas.length > 0 ? <ul className="readiness-areas is-review">{readiness.reviewAreas.map((area) => <li key={area}>{area}</li>)}</ul> : <p className="perf-note">No topic is flagged for review right now.</p>}
        </div>
      </div>

      {pastQuestions.answered > 0 && (
        <div className="quiz-actions readiness-actions">
          <MistakePractice label="Practice my mistakes" selection="missed" />
          {readiness.reviewAreas.length > 0 && <MistakePractice label="Review weak topics" selection="weak_topics" />}
        </div>
      )}
    </section>
  );
}

export function PerformanceView({ report }: { report: PerformanceReport }) {
  const { overall, trend, flashcards, activity } = report;
  const judged = report.topics.filter((topic) => topic.level !== null).length;

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> HOW YOU&apos;RE DOING</p>
          <h1>Performance<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Worked out from your own quiz, past-question and exam answers, and flashcard reviews.</p>
        </div>
        <Link className="action-button" href="/quizzes">Take a quiz</Link>
      </div>

      {!report.hasQuizData ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>✓</span></div>
          <strong>Not enough data yet</strong>
          <p>Complete your first quiz, or practise some past questions, to start seeing your performance and exam readiness.</p>
          <Link className="action-button" href="/quizzes">Start a quiz</Link>
        </div>
      ) : (
        <>
          {/* ------------------------------------------------------ overview */}
          <section aria-labelledby="perf-overview" className="perf-overview">
            <h2 className="visually-hidden" id="perf-overview">Overview</h2>
            <div className="perf-hero">
              <span>Overall accuracy</span>
              <strong>{percent(overall.accuracy!)}</strong>
              <LevelBadge level={report.level} />
              <p>
                {trend.direction === "insufficient" ? (
                  <>Answer a few more questions to see whether you&apos;re improving.</>
                ) : (
                  <>
                    <TrendLabel trend={trend} />: {percent(trend.previous!)} earlier, {percent(trend.recent!)} in your most recent answers.
                  </>
                )}
              </p>
            </div>
            <div className="perf-tiles">
              <Tile label="Questions attempted" value={number.format(overall.attempted)} />
              <Tile label="Answered correctly" value={number.format(overall.correct)} note={overall.partial > 0 ? `plus ${number.format(overall.partial)} partly correct` : undefined} />
              <Tile label="Answered incorrectly" value={number.format(overall.incorrect)} />
              <Tile label="Quizzes completed" value={number.format(report.quizzesCompleted)} />
              <Tile label="Average quiz score" value={report.averageScore === null ? "—" : percent(report.averageScore)} note={report.averageScore === null ? "Finish a quiz to see this" : undefined} />
              <Tile
                label={`Last ${activity.days} days`}
                value={`${activity.activeDays} ${activity.activeDays === 1 ? "day" : "days"} active`}
                note={`${number.format(activity.answers)} answers · ${number.format(activity.reviews)} cards reviewed`}
              />
            </div>
          </section>

          <ReadinessSection readiness={report.readiness} />

          {/* ---------------------------------------------------- weak areas */}
          <section aria-labelledby="perf-weak" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon plan-icon">!</span><h2 id="perf-weak">Needs review</h2></div>
            </div>
            {report.weakAreas.length > 0 ? (
              <ul className="perf-weak">
                {report.weakAreas.map((area) => (
                  <li key={`${area.subjectName}|${area.topic}`}>
                    <div>
                      <strong>{area.topic}</strong>
                      <span>{area.subjectName}</span>
                    </div>
                    <Accuracy level="needs_review" tally={area.tally} />
                    <p>
                      {area.reason === "low_accuracy"
                        ? `${score(area.tally.correct + area.tally.partial / 2)} of ${area.tally.attempted} answers right.`
                        : `${percent(area.tally.accuracy!)} overall, but ${percent(area.recentAccuracy!)} in your last ${PERFORMANCE.recentAnswers} answers.`}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="perf-note">
                {judged > 0
                  ? "No weak areas right now. Every topic with enough answers is at 60% or above."
                  : `Nothing to flag yet. A topic is only assessed once you've answered at least ${PERFORMANCE.minAttempts} questions on it.`}
              </p>
            )}
          </section>

          {/* ------------------------------------------------------ subjects */}
          <section aria-labelledby="perf-subjects" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon library-icon">▦</span><h2 id="perf-subjects">By subject</h2></div>
            </div>
            <div className="perf-table-wrap">
              <table className="perf-table">
                <thead>
                  <tr><th scope="col">Subject</th><th scope="col">Accuracy</th><th scope="col">Level</th><th scope="col">Questions</th><th scope="col">Right / wrong</th><th scope="col">Quizzes</th><th scope="col">Average</th><th scope="col">Latest</th><th scope="col">Trend</th></tr>
                </thead>
                <tbody>
                  {report.subjects.map((subject) => (
                    <tr key={subject.subjectId ?? "none"}>
                      <th scope="row">{subject.name}</th>
                      <td><Accuracy level={subject.level} tally={subject.tally} /></td>
                      <td><LevelBadge level={subject.level} /></td>
                      <td>{number.format(subject.tally.attempted)}</td>
                      <td>{number.format(subject.tally.correct)} / {number.format(subject.tally.incorrect)}{subject.tally.partial > 0 ? ` (+${subject.tally.partial} partly)` : ""}</td>
                      <td>{number.format(subject.quizzesCompleted)}</td>
                      <td>{subject.averageScore === null ? "—" : percent(subject.averageScore)}</td>
                      <td>{subject.recentScore === null ? "—" : percent(subject.recentScore)}</td>
                      <td><TrendLabel trend={subject.trend} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* -------------------------------------------------------- topics */}
          <section aria-labelledby="perf-topics" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon library-icon">▤</span><h2 id="perf-topics">By topic</h2></div>
            </div>
            {report.topics.length > 0 ? (
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <thead>
                    <tr><th scope="col">Topic</th><th scope="col">Subject</th><th scope="col">Accuracy</th><th scope="col">Level</th><th scope="col">Questions</th><th scope="col">Last answered</th></tr>
                  </thead>
                  <tbody>
                    {report.topics.map((topic) => (
                      <tr key={`${topic.subjectName}|${topic.topic}`}>
                        <th scope="row">{topic.topic}</th>
                        <td>{topic.subjectName}</td>
                        <td><Accuracy level={topic.level} tally={topic.tally} /></td>
                        <td><LevelBadge level={topic.level} /></td>
                        <td>{number.format(topic.tally.attempted)}</td>
                        <td>{formatDate(topic.lastAnsweredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="perf-note">None of the questions you&apos;ve answered carry a topic yet.</p>
            )}
            {report.untaggedAnswers > 0 && report.topics.length > 0 && (
              <p className="perf-note">{number.format(report.untaggedAnswers)} of your answers were to questions with no topic recorded, so they are counted in the totals but not listed here.</p>
            )}
          </section>

          {/* ------------------------------------------------------ mistakes */}
          <section aria-labelledby="perf-mistakes" className="lower-section">
            <div className="section-heading lower-heading">
              <div><span aria-hidden="true" className="section-icon plan-icon">✎</span><h2 id="perf-mistakes">Where the marks go</h2></div>
            </div>
            <div className="perf-columns">
              <div className="perf-card">
                <h3>By question type</h3>
                <ul className="perf-rows">
                  {report.mistakes.byType.map((row) => (
                    <li key={row.type}><span>{TYPE_LABELS[row.type]}</span><Accuracy tally={row.tally} /><em>{number.format(row.tally.attempted)} answered</em></li>
                  ))}
                </ul>
              </div>
              <div className="perf-card">
                <h3>By difficulty</h3>
                <ul className="perf-rows">
                  {report.mistakes.byDifficulty.map((row) => (
                    <li key={row.difficulty}><span>{DIFFICULTY_LABELS[row.difficulty]}</span><Accuracy tally={row.tally} /><em>{number.format(row.tally.attempted)} answered</em></li>
                  ))}
                </ul>
              </div>
            </div>
            {report.repeatedQuestions.length > 0 && (
              <div className="perf-card perf-repeated">
                <h3>Questions you&apos;ve missed more than once</h3>
                <ul>
                  {report.repeatedQuestions.map((item) => (
                    <li key={item.questionId}>
                      <p>{item.question}</p>
                      <span>{item.topic ? `${item.topic} · ` : ""}missed {item.misses} of {item.attempts} times</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* ------------------------------------------------ recent quizzes */}
          {report.recentQuizzes.length > 0 && (
            <section aria-labelledby="perf-recent" className="lower-section">
              <div className="section-heading lower-heading">
                <div><span aria-hidden="true" className="section-icon plan-icon">✓</span><h2 id="perf-recent">Recent quizzes</h2></div>
                <Link className="text-button" href="/quizzes">All quizzes <span aria-hidden="true">→</span></Link>
              </div>
              <div className="perf-table-wrap">
                <table className="perf-table">
                  <thead>
                    <tr><th scope="col">Quiz</th><th scope="col">Subject</th><th scope="col">Score</th><th scope="col">Result</th><th scope="col">Completed</th></tr>
                  </thead>
                  <tbody>
                    {report.recentQuizzes.map((quiz) => (
                      <tr key={`${quiz.quizId}|${quiz.completedAt}`}>
                        <th scope="row"><Link href={quiz.href}>{quiz.title}</Link></th>
                        <td>{quiz.subjectName}</td>
                        <td><Accuracy level={null} tally={{ attempted: quiz.total, correct: 0, partial: 0, incorrect: 0, accuracy: quiz.percent }} /></td>
                        <td>{score(quiz.score)} / {quiz.total}</td>
                        <td>{formatDate(quiz.completedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------------------- flashcards */}
      {(report.hasQuizData || flashcards.reviewed > 0) && (
        <section aria-labelledby="perf-cards" className="lower-section">
          <div className="section-heading lower-heading">
            <div><span aria-hidden="true" className="section-icon library-icon">❏</span><h2 id="perf-cards">Flashcard activity</h2></div>
            <Link className="text-button" href="/flashcards">Flashcards <span aria-hidden="true">→</span></Link>
          </div>
          {flashcards.reviewed === 0 ? (
            <p className="perf-note">You haven&apos;t reviewed any flashcards yet.</p>
          ) : (
            <>
              <div className="perf-tiles is-cards">
                <Tile label="Cards reviewed" value={number.format(flashcards.reviewed)} note={flashcards.lastReviewedAt ? `Last on ${formatDate(flashcards.lastReviewedAt)}` : undefined} />
                <Tile label={`In the last ${activity.days} days`} value={number.format(flashcards.reviewedRecently)} />
                <Tile label="Again" value={number.format(flashcards.ratings.again)} />
                <Tile label="Hard" value={number.format(flashcards.ratings.hard)} />
                <Tile label="Good" value={number.format(flashcards.ratings.good)} />
                <Tile label="Easy" value={number.format(flashcards.ratings.easy)} />
              </div>
              <p className="perf-note">Ratings are how each card felt when you reviewed it. They show activity, not how you would score in a quiz.</p>
            </>
          )}
        </section>
      )}

      <footer className="dashboard-footer">
        <span>Calculated from your answers each time you open this page.</span>
        <span>ARI <i>·</i> BUILT BY PALADIN</span>
      </footer>
    </>
  );
}
