// Every threshold the performance page uses, in one place. Changing a number
// here changes how results are labelled everywhere; nothing else needs to be
// edited. None of this involves an AI model: it is all arithmetic on the
// student's own quiz answers and flashcard reviews.

export const PERFORMANCE = {
  // --- Levels ---------------------------------------------------------------
  // Accuracy at or above this is "Strong".
  strongAccuracy: 0.8,
  // Accuracy at or above this (and below strong) is "Developing". Anything
  // lower is "Needs review".
  developingAccuracy: 0.6,
  // Answers needed before a subject or topic is given a level at all. One
  // wrong answer is not a weak area.
  minAttempts: 3,

  // --- Trend ------------------------------------------------------------------
  // The most recent answers are compared with the same number before them.
  trendWindow: 10,
  // Answers needed in each half before a trend is reported.
  trendMinPerWindow: 4,
  // How far accuracy must move, as a fraction, to count as a change.
  trendThreshold: 0.08,

  // --- Weak areas -------------------------------------------------------------
  // A topic that is fine overall can still be slipping: its latest answers
  // are checked on their own.
  recentAnswers: 5,
  recentMinAnswers: 3,
  // Times the same question must be missed to be listed as a repeated miss.
  repeatedMisses: 2,

  // --- How much is shown and loaded ------------------------------------------
  recentQuizzes: 8,
  activityDays: 7,
  maxTopics: 30,
  maxRepeatedQuestions: 5,
  // The most recent records considered. Far more than a student will have
  // for a long time; a bound all the same.
  maxAnswers: 5000,
  maxAttempts: 1000,
  maxReviews: 2000,
};

// Exam readiness: one transparent figure built from the student's own
// records. The formula is in lib/performance/readiness.ts; every number it
// uses is here, so the thresholds and weights can be changed in one place.
export const READINESS = {
  // --- Status ---------------------------------------------------------------
  // A score at or above this is "Strong".
  strongScore: 80,
  // At or above this (and below strong) is "Developing". Lower is "Needs review".
  developingScore: 60,

  // --- What the score is made of ---------------------------------------------
  // Each part is a fraction from 0 to 1. Parts with no data yet are left out
  // and the remaining weights are scaled up to fill the whole.
  weights: {
    // Average score of the most recent exam simulations.
    exams: 0.35,
    // Accuracy on past questions in practice.
    pastQuestions: 0.25,
    // Accuracy on quizzes Ari wrote from study materials.
    quizzes: 0.2,
    // Share of the topics in the uploaded past questions that have been practised.
    coverage: 0.1,
    // How many of the last days had any practice.
    consistency: 0.1,
  },
  // Exam simulations averaged.
  examWindow: 5,
  // Most recent answers counted for each accuracy.
  answerWindow: 100,
  // Answers needed before an accuracy counts towards the score at all.
  minAnswersPerSource: 5,
  // Answers needed, in total, before any score is shown.
  minAnswers: 10,
  // Practising on this many of the last `consistencyDays` days is full marks.
  consistencyDays: 14,
  consistencyTargetDays: 7,
  // Points taken off for each topic currently flagged as needing review...
  weakAreaPenalty: 2,
  // ...up to this many in all.
  maxWeakAreaPenalty: 10,

  // --- Trend -------------------------------------------------------------------
  // Accuracy in the last `periodDays` days against the same period before it.
  periodDays: 14,
  // Answers needed in each period before a change is reported.
  trendMinAnswers: 5,

  // --- How much is listed -------------------------------------------------------
  maxAreas: 5,
};

export type Level = "strong" | "developing" | "needs_review";

export const LEVEL_LABELS: Record<Level, string> = {
  strong: "Strong",
  developing: "Developing",
  needs_review: "Needs review",
};
