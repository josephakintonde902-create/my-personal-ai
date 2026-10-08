import { tallyOf, type AnswerRecord, type AttemptRecord, type Performance, type QuizRecord } from "./compute";
import { READINESS, type Level } from "./config";

// Exam readiness: how prepared the student's own practice suggests they are.
// Pure arithmetic on their records: no AI model, no database, no clock of
// its own. It describes practice so far. It is not a prediction of a result,
// and nothing here says or implies that the student will pass.
//
// THE FORMULA
//
//   Each part is a fraction between 0 and 1:
//
//     exams          mean score of the last 5 exam simulations         weight 0.35
//     pastQuestions  accuracy of the last 100 past-question answers    weight 0.25
//     quizzes        accuracy of the last 100 quiz answers             weight 0.20
//     coverage       topics practised ÷ topics in the past questions   weight 0.10
//     consistency    days practised in the last 14 ÷ 7 (at most 1)     weight 0.10
//
//   A part with too little behind it (no exam yet, fewer than 5 answers, no
//   labelled topics) is left out, and the weights of the parts that remain
//   are scaled so they still add up to 1:
//
//     base = Σ (weight × value) ÷ Σ weight            over the parts available
//
//   Topics currently flagged "needs review" each take 2 points off, to a
//   maximum of 10:
//
//     score = round(100 × base) − min(10, 2 × weak topics)      kept within 0–100
//
//   No score is given until there are at least 10 answers in all and at
//   least one of the three accuracy parts is available.
//
//   80 and above is "Strong", 60 and above "Developing", below that "Needs
//   review". All of these numbers live in READINESS (lib/performance/config.ts).

export type ReadinessPartKey = keyof typeof READINESS.weights;

export type ReadinessPart = {
  key: ReadinessPartKey;
  label: string;
  // Null when there is not enough data for this part to count.
  value: number | null;
  // Its weight as configured, and the share it actually had in this score.
  weight: number;
  share: number;
  // What the value was worked out from, in words.
  detail: string;
};

export type Readiness = {
  // Null until there is enough practice to say anything.
  score: number | null;
  status: Level | null;
  parts: ReadinessPart[];
  // Points taken off for weak topics.
  penalty: number;
  // Answers still needed before a score is shown.
  answersNeeded: number;
  strongAreas: string[];
  reviewAreas: string[];
  trend: {
    // Change in accuracy, in percentage points. Null without enough answers in both periods.
    change: number | null;
    recent: number | null;
    previous: number | null;
    days: number;
  };
  exams: { completed: number; latestPercent: number | null; averagePercent: number | null; latestAt: string | null };
  // Practice and exam answers to uploaded past questions, together.
  pastQuestions: { answered: number; accuracy: number | null };
  recommendation: string;
};

export type ReadinessInput = {
  answers: AnswerRecord[];
  // Completed attempts only.
  attempts: AttemptRecord[];
  quizzes: QuizRecord[];
  performance: Pick<Performance, "weakAreas" | "subjects" | "topics">;
  // The topic of each of the student's uploaded past questions.
  pastTopics: string[];
  now: Date;
};

const DAY = 24 * 60 * 60_000;

function normalize(topic: string) {
  return topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function recent<T extends { answeredAt: string }>(answers: T[], count: number) {
  return [...answers].sort((a, b) => b.answeredAt.localeCompare(a.answeredAt)).slice(0, count);
}

function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function statusOf(score: number): Level {
  if (score >= READINESS.strongScore) return "strong";
  return score >= READINESS.developingScore ? "developing" : "needs_review";
}

export function computeReadiness({ answers, attempts, quizzes, performance, pastTopics, now }: ReadinessInput): Readiness {
  const modeOf = new Map(quizzes.map((quiz) => [quiz.id, quiz.mode ?? "quiz"]));
  const isMode = (quizId: string, ...modes: string[]) => modes.includes(modeOf.get(quizId) ?? "quiz");

  // ------------------------------------------------------------------ parts
  const examAttempts = attempts.filter((attempt) => isMode(attempt.quizId, "exam")).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const examScores = examAttempts.slice(0, READINESS.examWindow).map((attempt) => (attempt.total > 0 ? attempt.score / attempt.total : 0));
  const examAverage = examScores.length ? examScores.reduce((sum, value) => sum + value, 0) / examScores.length : null;

  const practiceAnswers = recent(answers.filter((answer) => isMode(answer.quizId, "past_practice")), READINESS.answerWindow);
  const quizAnswers = recent(answers.filter((answer) => isMode(answer.quizId, "quiz", "practice")), READINESS.answerWindow);
  const accuracyOf = (own: AnswerRecord[]) => (own.length >= READINESS.minAnswersPerSource ? tallyOf(own).accuracy : null);

  const topics = new Set(pastTopics.map(normalize).filter((topic) => topic && topic !== "uncategorized"));
  const practised = new Set(answers.filter((answer) => isMode(answer.quizId, "past_practice", "exam") && answer.topic).map((answer) => normalize(answer.topic!)));
  const covered = [...topics].filter((topic) => practised.has(topic)).length;

  const since = now.getTime() - READINESS.consistencyDays * DAY;
  const activeDays = new Set(answers.filter((answer) => Date.parse(answer.answeredAt) >= since).map((answer) => answer.answeredAt.slice(0, 10))).size;

  const values: Record<ReadinessPartKey, { label: string; value: number | null; detail: string }> = {
    exams: {
      label: "Exam simulations",
      value: examAverage,
      detail: examScores.length ? `Average of your last ${examScores.length} exam ${examScores.length === 1 ? "simulation" : "simulations"}` : "No exam simulation completed yet",
    },
    pastQuestions: {
      label: "Past-question practice",
      value: accuracyOf(practiceAnswers),
      detail: practiceAnswers.length >= READINESS.minAnswersPerSource ? `Your last ${practiceAnswers.length} past-question answers` : `Needs ${READINESS.minAnswersPerSource} past-question answers`,
    },
    quizzes: {
      label: "Quizzes",
      value: accuracyOf(quizAnswers),
      detail: quizAnswers.length >= READINESS.minAnswersPerSource ? `Your last ${quizAnswers.length} quiz answers` : `Needs ${READINESS.minAnswersPerSource} quiz answers`,
    },
    coverage: {
      label: "Topic coverage",
      value: topics.size > 0 ? covered / topics.size : null,
      detail: topics.size > 0 ? `${covered} of ${topics.size} topics in your past questions practised` : "No labelled topics in your past questions yet",
    },
    consistency: {
      label: "Consistency",
      value: answers.length > 0 ? Math.min(1, activeDays / READINESS.consistencyTargetDays) : null,
      detail: `Practised on ${activeDays} of the last ${READINESS.consistencyDays} days`,
    },
  };

  const keys = Object.keys(READINESS.weights) as ReadinessPartKey[];
  const totalWeight = keys.reduce((sum, key) => sum + (values[key].value === null ? 0 : READINESS.weights[key]), 0);
  const parts: ReadinessPart[] = keys.map((key) => ({
    key,
    ...values[key],
    weight: READINESS.weights[key],
    share: values[key].value === null || totalWeight === 0 ? 0 : READINESS.weights[key] / totalWeight,
  }));

  // ------------------------------------------------------------------ score
  const hasAccuracy = (["exams", "pastQuestions", "quizzes"] as const).some((key) => values[key].value !== null);
  const enough = answers.length >= READINESS.minAnswers && hasAccuracy;
  const penalty = Math.min(READINESS.maxWeakAreaPenalty, performance.weakAreas.length * READINESS.weakAreaPenalty);
  const base = parts.reduce((sum, part) => sum + part.share * (part.value ?? 0), 0);
  const score = enough ? Math.max(0, Math.min(100, Math.round(base * 100) - penalty)) : null;

  // ------------------------------------------------------------------ trend
  const period = READINESS.periodDays * DAY;
  const inPeriod = (from: number, to: number) => answers.filter((answer) => Date.parse(answer.answeredAt) >= from && Date.parse(answer.answeredAt) < to);
  const latest = inPeriod(now.getTime() - period, now.getTime() + 1);
  const earlier = inPeriod(now.getTime() - 2 * period, now.getTime() - period);
  const comparable = latest.length >= READINESS.trendMinAnswers && earlier.length >= READINESS.trendMinAnswers;
  const recentAccuracy = comparable ? tallyOf(latest).accuracy! : null;
  const previousAccuracy = comparable ? tallyOf(earlier).accuracy! : null;
  const change = comparable ? Math.round((recentAccuracy! - previousAccuracy!) * 100) : null;

  // ------------------------------------------------------------------ areas
  const strongAreas = [
    ...performance.subjects.filter((subject) => subject.level === "strong" && subject.subjectId).map((subject) => subject.name),
    ...performance.topics.filter((topic) => topic.level === "strong").map((topic) => topic.topic),
  ];
  const reviewAreas = performance.weakAreas.map((area) => area.topic);
  const unique = (items: string[]) => [...new Set(items)].slice(0, READINESS.maxAreas);

  const pastAnswers = answers.filter((answer) => isMode(answer.quizId, "past_practice", "exam"));
  const readiness: Omit<Readiness, "recommendation"> = {
    score,
    status: score === null ? null : statusOf(score),
    parts,
    penalty: enough ? penalty : 0,
    answersNeeded: Math.max(0, READINESS.minAnswers - answers.length),
    strongAreas: unique(strongAreas),
    reviewAreas: unique(reviewAreas),
    trend: { change, recent: recentAccuracy, previous: previousAccuracy, days: READINESS.periodDays },
    exams: {
      completed: examAttempts.length,
      latestPercent: examAttempts[0] ? Math.round((examAttempts[0].total > 0 ? examAttempts[0].score / examAttempts[0].total : 0) * 100) : null,
      averagePercent: examAverage === null ? null : Math.round(examAverage * 100),
      latestAt: examAttempts[0]?.completedAt ?? null,
    },
    pastQuestions: { answered: pastAnswers.length, accuracy: tallyOf(pastAnswers).accuracy },
  };
  return { ...readiness, recommendation: recommend(readiness, { covered, topics: topics.size }) };
}

// One or two sentences on what to do next, chosen by rule from the figures
// above. No model writes this, and it never promises an outcome.
function recommend(readiness: Omit<Readiness, "recommendation">, coverage: { covered: number; topics: number }) {
  if (readiness.score === null) {
    return readiness.answersNeeded > 0
      ? `Answer ${readiness.answersNeeded} more ${readiness.answersNeeded === 1 ? "question" : "questions"} to see your readiness. A short past-question practice session is a good place to start.`
      : "Practise a few more questions of one kind to see your readiness.";
  }

  const review = readiness.reviewAreas.slice(0, 2);
  const next = readiness.exams.completed === 0 ? "trying your first exam simulation" : "taking another full exam simulation";
  if (review.length > 0) return `Focus on ${list(review)} before ${next}.`;
  if (readiness.exams.completed === 0) return "Your practice so far looks steady. Try a timed exam simulation to see how it holds up under exam conditions.";
  if (coverage.topics > 0 && coverage.covered / coverage.topics < 0.5) {
    return `You have practised ${coverage.covered} of the ${coverage.topics} topics in your past questions. Try the ones you haven't touched yet.`;
  }
  if (readiness.trend.change !== null && readiness.trend.change <= -5) {
    return `Your accuracy is ${Math.abs(readiness.trend.change)} points lower than in the previous ${readiness.trend.days} days. Go back over your recent mistakes before moving on.`;
  }
  if (readiness.status === "strong") return `Your current practice performance suggests you are well prepared. Keep it steady with regular mixed practice${readiness.exams.averagePercent === null ? "" : ` (recent exams average ${readiness.exams.averagePercent}%)`}.`;
  return `Your current practice performance suggests you are getting there. Keep practising past questions and aim to lift your accuracy above ${percent(READINESS.strongScore / 100)}.`;
}
