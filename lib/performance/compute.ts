import type { AnswerResult, Difficulty, QuestionType, Rating } from "@/lib/ai/practice/types";
import { PERFORMANCE, type Level } from "./config";

// Works out a student's performance from their own records. Pure functions:
// rows in, numbers out. No database, no clock of its own, and no AI model.
// Everything a student sees on the performance page can be traced to the
// answers and reviews passed in here.

// ----------------------------------------------------------------- records

export type AnswerRecord = {
  questionId: string;
  quizId: string;
  result: AnswerResult;
  answeredAt: string;
  // Null for questions whose details are no longer available.
  questionType: QuestionType | null;
  difficulty: Difficulty | null;
  topic: string | null;
};

export type AttemptRecord = { id?: string; quizId: string; score: number; total: number; completedAt: string };
// `mode` separates Ari's quizzes from past-question practice and exams.
// Absent means an ordinary quiz.
export type QuizRecord = { id: string; title: string; subjectId: string | null; mode?: "quiz" | "practice" | "past_practice" | "exam" };
export type ReviewRecord = { rating: Rating; reviewedAt: string };

export type PerformanceInput = {
  answers: AnswerRecord[];
  // Completed attempts only.
  attempts: AttemptRecord[];
  quizzes: QuizRecord[];
  subjects: { id: string; name: string }[];
  // The most recent reviews, and how many there have been in all.
  reviews: ReviewRecord[];
  reviewsTotal: number;
  now: Date;
};

// ----------------------------------------------------------------- results

export type Tally = {
  attempted: number;
  correct: number;
  partial: number;
  incorrect: number;
  // Correct answers count 1 and partly correct ones a half, the same way a
  // quiz is scored. Null when nothing has been attempted.
  accuracy: number | null;
};

export type Trend = {
  direction: "improving" | "stable" | "declining" | "insufficient";
  // Accuracy in the earlier and the later group of answers compared.
  previous: number | null;
  recent: number | null;
};

export type SubjectPerformance = {
  // Null groups quizzes that span all subjects, or whose subject was deleted.
  subjectId: string | null;
  name: string;
  tally: Tally;
  // Null until there is enough evidence to say.
  level: Level | null;
  quizzesCompleted: number;
  averageScore: number | null;
  recentScore: number | null;
  trend: Trend;
};

export type TopicPerformance = {
  topic: string;
  subjectName: string;
  tally: Tally;
  level: Level | null;
  trend: Trend;
  lastAnsweredAt: string;
};

export type WeakArea = {
  topic: string;
  subjectName: string;
  tally: Tally;
  // Why it was flagged: low accuracy overall, or only in the latest answers.
  reason: "low_accuracy" | "recent_decline";
  recentAccuracy: number | null;
};

export type Performance = {
  // False until the student has answered at least one quiz question.
  hasQuizData: boolean;
  overall: Tally;
  level: Level | null;
  trend: Trend;
  quizzesCompleted: number;
  // The mean of completed quiz scores, as a fraction.
  averageScore: number | null;
  // `href` is where the attempt can be opened: an exam has its own page.
  recentQuizzes: { quizId: string; title: string; subjectName: string; score: number; total: number; percent: number; completedAt: string; href: string }[];
  subjects: SubjectPerformance[];
  topics: TopicPerformance[];
  // Answers to questions that carry no topic. Counted, never guessed at.
  untaggedAnswers: number;
  weakAreas: WeakArea[];
  mistakes: {
    byType: { type: QuestionType; tally: Tally }[];
    byDifficulty: { difficulty: Difficulty; tally: Tally }[];
    // Questions missed more than once, most missed first.
    repeated: { questionId: string; misses: number; attempts: number }[];
  };
  flashcards: {
    reviewed: number;
    reviewedRecently: number;
    // Of the recent reviews loaded. Activity, not mastery.
    ratings: Record<Rating, number>;
    lastReviewedAt: string | null;
  };
  activity: {
    days: number;
    activeDays: number;
    answers: number;
    reviews: number;
    lastActiveAt: string | null;
  };
};

// ------------------------------------------------------------ calculations

const POINTS: Record<AnswerResult, number> = { correct: 1, partial: 0.5, incorrect: 0 };

export function tallyOf(answers: Pick<AnswerRecord, "result">[]): Tally {
  const tally = { attempted: answers.length, correct: 0, partial: 0, incorrect: 0 };
  let points = 0;
  for (const answer of answers) {
    tally[answer.result]++;
    points += POINTS[answer.result];
  }
  return { ...tally, accuracy: answers.length ? points / answers.length : null };
}

// The level for a set of answers, or null while there are too few to judge.
export function levelOf(tally: Tally): Level | null {
  if (tally.accuracy === null || tally.attempted < PERFORMANCE.minAttempts) return null;
  if (tally.accuracy >= PERFORMANCE.strongAccuracy) return "strong";
  if (tally.accuracy >= PERFORMANCE.developingAccuracy) return "developing";
  return "needs_review";
}

function byTime<T extends { answeredAt: string }>(answers: T[]) {
  return [...answers].sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

// Compares the most recent answers with the same number just before them.
// With too few answers to fill both groups, no trend is claimed.
export function trendOf(answers: Pick<AnswerRecord, "result" | "answeredAt">[]): Trend {
  const ordered = byTime(answers);
  const size = Math.min(PERFORMANCE.trendWindow, Math.floor(ordered.length / 2));
  if (size < PERFORMANCE.trendMinPerWindow) return { direction: "insufficient", previous: null, recent: null };

  const recent = tallyOf(ordered.slice(-size)).accuracy!;
  const previous = tallyOf(ordered.slice(-2 * size, -size)).accuracy!;
  const change = recent - previous;
  const direction = change >= PERFORMANCE.trendThreshold ? "improving" : change <= -PERFORMANCE.trendThreshold ? "declining" : "stable";
  return { direction, previous, recent };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function groupBy<T, K>(items: T[], key: (item: T) => K) {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function normalizeTopic(topic: string) {
  return topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function dayOf(iso: string) {
  return iso.slice(0, 10);
}

const NO_SUBJECT = "All subjects";

export function computePerformance({ answers, attempts, quizzes, subjects, reviews, reviewsTotal, now }: PerformanceInput): Performance {
  const quizById = new Map(quizzes.map((quiz) => [quiz.id, quiz]));
  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  // A subject that has since been deleted is treated as no subject.
  const subjectOf = (quizId: string) => {
    const subjectId = quizById.get(quizId)?.subjectId ?? null;
    return subjectId && subjectNames.has(subjectId) ? subjectId : null;
  };
  const nameOf = (subjectId: string | null) => (subjectId ? subjectNames.get(subjectId)! : NO_SUBJECT);
  const completed = [...attempts].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const percentOf = (attempt: AttemptRecord) => (attempt.total > 0 ? attempt.score / attempt.total : 0);

  // ------------------------------------------------------------- subjects
  const answersBySubject = groupBy(answers, (answer) => subjectOf(answer.quizId));
  const attemptsBySubject = groupBy(completed, (attempt) => subjectOf(attempt.quizId));
  const subjectIds = new Set([...answersBySubject.keys(), ...attemptsBySubject.keys()]);

  const subjectRows: SubjectPerformance[] = [...subjectIds]
    .map((subjectId) => {
      const own = answersBySubject.get(subjectId) ?? [];
      const ownAttempts = attemptsBySubject.get(subjectId) ?? [];
      const tally = tallyOf(own);
      return {
        subjectId,
        name: nameOf(subjectId),
        tally,
        level: levelOf(tally),
        quizzesCompleted: ownAttempts.length,
        averageScore: mean(ownAttempts.map(percentOf)),
        recentScore: ownAttempts.length ? percentOf(ownAttempts[0]) : null,
        trend: trendOf(own),
      };
    })
    .sort((a, b) => b.tally.attempted - a.tally.attempted || a.name.localeCompare(b.name));

  // --------------------------------------------------------------- topics
  // A topic belongs to its subject: "Structure" in Anatomy and in Chemistry
  // are different topics.
  const tagged = answers.filter((answer) => answer.topic && normalizeTopic(answer.topic));
  const answersByTopic = groupBy(tagged, (answer) => `${subjectOf(answer.quizId) ?? ""}|${normalizeTopic(answer.topic!)}`);

  const topicRows = [...answersByTopic.values()].map((own) => {
    const ordered = byTime(own);
    const tally = tallyOf(own);
    // Shown the way it was most often written.
    const spellings = groupBy(own, (answer) => answer.topic!.trim());
    const topic = [...spellings.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][0];
    const latest = ordered.slice(-PERFORMANCE.recentAnswers);
    return {
      topic,
      subjectName: nameOf(subjectOf(own[0].quizId)),
      tally,
      level: levelOf(tally),
      trend: trendOf(own),
      lastAnsweredAt: ordered[ordered.length - 1].answeredAt,
      recentAccuracy: latest.length >= PERFORMANCE.recentMinAnswers ? tallyOf(latest).accuracy : null,
    };
  });

  // ----------------------------------------------------------- weak areas
  // Flagged only with enough evidence: accuracy below the "developing" line
  // overall, or in the latest answers of a topic that is otherwise fine.
  const weakAreas: WeakArea[] = topicRows
    .filter((row) => row.tally.attempted >= PERFORMANCE.minAttempts)
    .flatMap((row): WeakArea[] => {
      const { topic, subjectName, tally, recentAccuracy } = row;
      if (tally.accuracy! < PERFORMANCE.developingAccuracy) return [{ topic, subjectName, tally, reason: "low_accuracy", recentAccuracy }];
      // "Recent" must mean something: the topic needs earlier answers too.
      if (recentAccuracy !== null && recentAccuracy < PERFORMANCE.developingAccuracy && tally.attempted > PERFORMANCE.recentAnswers) {
        return [{ topic, subjectName, tally, reason: "recent_decline", recentAccuracy }];
      }
      return [];
    })
    .sort((a, b) => (a.recentAccuracy ?? a.tally.accuracy!) - (b.recentAccuracy ?? b.tally.accuracy!) || b.tally.attempted - a.tally.attempted);

  const topics: TopicPerformance[] = topicRows
    .map((row) => ({ topic: row.topic, subjectName: row.subjectName, tally: row.tally, level: row.level, trend: row.trend, lastAnsweredAt: row.lastAnsweredAt }))
    .sort((a, b) => b.tally.attempted - a.tally.attempted || a.topic.localeCompare(b.topic))
    .slice(0, PERFORMANCE.maxTopics);

  // -------------------------------------------------------------- mistakes
  const types: QuestionType[] = ["multiple_choice", "true_false", "short_answer"];
  const difficulties: Difficulty[] = ["easy", "medium", "hard"];
  const repeated = [...groupBy(answers, (answer) => answer.questionId).entries()]
    .map(([questionId, own]) => ({ questionId, misses: own.filter((answer) => answer.result !== "correct").length, attempts: own.length }))
    .filter((entry) => entry.misses >= PERFORMANCE.repeatedMisses)
    .sort((a, b) => b.misses - a.misses || b.attempts - a.attempts)
    .slice(0, PERFORMANCE.maxRepeatedQuestions);

  // -------------------------------------------------------------- activity
  const since = now.getTime() - PERFORMANCE.activityDays * 24 * 60 * 60_000;
  const within = (iso: string) => Date.parse(iso) >= since;
  const recentAnswers = answers.filter((answer) => within(answer.answeredAt));
  const recentReviews = reviews.filter((review) => within(review.reviewedAt));
  const moments = [...answers.map((answer) => answer.answeredAt), ...reviews.map((review) => review.reviewedAt)].sort();

  const ratings: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const review of reviews) ratings[review.rating]++;
  const reviewTimes = reviews.map((review) => review.reviewedAt).sort();

  const overall = tallyOf(answers);
  return {
    hasQuizData: answers.length > 0,
    overall,
    level: levelOf(overall),
    trend: trendOf(answers),
    quizzesCompleted: completed.length,
    averageScore: mean(completed.map(percentOf)),
    recentQuizzes: completed.slice(0, PERFORMANCE.recentQuizzes).map((attempt) => ({
      quizId: attempt.quizId,
      title: quizById.get(attempt.quizId)?.title ?? "Quiz",
      subjectName: nameOf(subjectOf(attempt.quizId)),
      score: attempt.score,
      total: attempt.total,
      percent: percentOf(attempt),
      completedAt: attempt.completedAt,
      href: quizById.get(attempt.quizId)?.mode === "exam" && attempt.id ? `/exam/${attempt.id}` : `/quizzes/${attempt.quizId}`,
    })),
    subjects: subjectRows,
    topics,
    untaggedAnswers: answers.length - tagged.length,
    weakAreas,
    mistakes: {
      byType: types.map((type) => ({ type, tally: tallyOf(answers.filter((answer) => answer.questionType === type)) })).filter((row) => row.tally.attempted > 0),
      byDifficulty: difficulties
        .map((difficulty) => ({ difficulty, tally: tallyOf(answers.filter((answer) => answer.difficulty === difficulty)) }))
        .filter((row) => row.tally.attempted > 0),
      repeated,
    },
    flashcards: {
      reviewed: Math.max(reviewsTotal, reviews.length),
      reviewedRecently: recentReviews.length,
      ratings,
      lastReviewedAt: reviewTimes[reviewTimes.length - 1] ?? null,
    },
    activity: {
      days: PERFORMANCE.activityDays,
      activeDays: new Set([...recentAnswers.map((answer) => dayOf(answer.answeredAt)), ...recentReviews.map((review) => dayOf(review.reviewedAt))]).size,
      answers: recentAnswers.length,
      reviews: recentReviews.length,
      lastActiveAt: moments[moments.length - 1] ?? null,
    },
  };
}
