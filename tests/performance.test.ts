import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnswerResult } from "@/lib/ai/practice/types";
import { computePerformance, levelOf, tallyOf, trendOf, type AnswerRecord, type PerformanceInput } from "@/lib/performance/compute";
import { PERFORMANCE } from "@/lib/performance/config";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const OPTICS = "subject-optics";
const BIOLOGY = "subject-biology";

let counter = 0;
// One answer, a given number of hours before NOW.
function answer(result: AnswerResult, hoursAgo: number, overrides: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    questionId: `q-${++counter}`,
    quizId: "quiz-optics",
    result,
    answeredAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    questionType: "multiple_choice",
    difficulty: "medium",
    topic: "Refraction",
    ...overrides,
  };
}

// Results written as a string, oldest first: "c" correct, "p" partial, "x" incorrect.
function run(pattern: string, overrides: Partial<AnswerRecord> = {}, startHoursAgo = 100) {
  const results: Record<string, AnswerResult> = { c: "correct", p: "partial", x: "incorrect" };
  return [...pattern].map((letter, index) => answer(results[letter], startHoursAgo - index, overrides));
}

function input(overrides: Partial<PerformanceInput> = {}): PerformanceInput {
  return {
    answers: [],
    attempts: [],
    quizzes: [
      { id: "quiz-optics", title: "Optics quiz", subjectId: OPTICS },
      { id: "quiz-biology", title: "Biology quiz", subjectId: BIOLOGY },
      { id: "quiz-mixed", title: "Mixed quiz", subjectId: null },
    ],
    subjects: [{ id: OPTICS, name: "Optics" }, { id: BIOLOGY, name: "Biology" }],
    reviews: [],
    reviewsTotal: 0,
    now: NOW,
    ...overrides,
  };
}

describe("performance: accuracy", () => {
  it("has nothing to say before the student has answered anything", () => {
    const performance = computePerformance(input());

    assert.equal(performance.hasQuizData, false);
    assert.deepEqual(performance.overall, { attempted: 0, correct: 0, partial: 0, incorrect: 0, accuracy: null });
    assert.equal(performance.level, null);
    assert.equal(performance.averageScore, null);
    assert.deepEqual(performance.trend, { direction: "insufficient", previous: null, recent: null });
    assert.equal(performance.quizzesCompleted, 0);
    assert.deepEqual([performance.subjects, performance.topics, performance.weakAreas, performance.recentQuizzes], [[], [], [], []]);
    assert.deepEqual(performance.mistakes, { byType: [], byDifficulty: [], repeated: [] });
    assert.deepEqual(performance.flashcards, { reviewed: 0, reviewedRecently: 0, ratings: { again: 0, hard: 0, good: 0, easy: 0 }, lastReviewedAt: null });
    assert.equal(performance.activity.lastActiveAt, null);
  });

  it("calculates overall accuracy, counting a partly correct answer as half", () => {
    const performance = computePerformance(input({ answers: run("cccxxp" + "cc") }));

    assert.deepEqual(performance.overall, { attempted: 8, correct: 5, partial: 1, incorrect: 2, accuracy: 5.5 / 8 });
    assert.equal(performance.hasQuizData, true);
    assert.equal(performance.level, "developing");
  });

  it("averages completed quiz scores separately from answer accuracy", () => {
    const attempts = [
      { quizId: "quiz-optics", score: 8, total: 10, completedAt: "2026-10-05T10:00:00.000Z" },
      { quizId: "quiz-optics", score: 3, total: 5, completedAt: "2026-10-06T10:00:00.000Z" },
      { quizId: "quiz-biology", score: 2.5, total: 5, completedAt: "2026-10-07T10:00:00.000Z" },
    ];
    const performance = computePerformance(input({ attempts, answers: run("cc") }));

    assert.equal(performance.quizzesCompleted, 3);
    assert.ok(Math.abs(performance.averageScore! - (0.8 + 0.6 + 0.5) / 3) < 1e-9);
    // Most recent first, with the quiz and subject they belong to.
    assert.deepEqual(performance.recentQuizzes.map((quiz) => [quiz.title, quiz.subjectName, quiz.percent]), [
      ["Biology quiz", "Biology", 0.5],
      ["Optics quiz", "Optics", 0.6],
      ["Optics quiz", "Optics", 0.8],
    ]);
  });

  it("breaks accuracy down by subject", () => {
    const answers = [
      ...run("cccx"),
      ...run("xxxc", { quizId: "quiz-biology", topic: "Cells" }),
      ...run("cc", { quizId: "quiz-mixed", topic: "Mixed" }),
    ];
    const attempts = [
      { quizId: "quiz-optics", score: 3, total: 4, completedAt: "2026-10-06T10:00:00.000Z" },
      { quizId: "quiz-biology", score: 1, total: 4, completedAt: "2026-10-05T10:00:00.000Z" },
      { quizId: "quiz-biology", score: 3, total: 4, completedAt: "2026-10-07T10:00:00.000Z" },
    ];
    const { subjects } = computePerformance(input({ answers, attempts }));
    const by = Object.fromEntries(subjects.map((subject) => [subject.name, subject]));

    assert.deepEqual(Object.keys(by).sort(), ["All subjects", "Biology", "Optics"]);
    assert.equal(by.Optics.tally.accuracy, 0.75);
    assert.equal(by.Optics.level, "developing");
    assert.equal(by.Optics.quizzesCompleted, 1);
    assert.equal(by.Biology.tally.accuracy, 0.25);
    assert.equal(by.Biology.level, "needs_review");
    assert.deepEqual([by.Biology.quizzesCompleted, by.Biology.averageScore, by.Biology.recentScore], [2, 0.5, 0.75]);
    // Quizzes across all subjects are their own group, not folded into one.
    assert.equal(by["All subjects"].subjectId, null);
    assert.equal(by["All subjects"].level, null, "two answers are too few for a level");
  });

  it("treats a quiz whose subject was deleted as having no subject", () => {
    const performance = computePerformance(input({ answers: run("ccc"), subjects: [{ id: BIOLOGY, name: "Biology" }] }));
    assert.deepEqual(performance.subjects.map((subject) => [subject.subjectId, subject.name]), [[null, "All subjects"]]);
  });

  it("breaks accuracy down by topic within a subject, ignoring case and punctuation", () => {
    const answers = [
      ...run("ccc", { topic: "Refraction" }),
      ...run("x", { topic: "refraction " }),
      ...run("xxc", { topic: "Accommodation" }),
      // The same word in another subject is a different topic.
      ...run("cc", { topic: "Refraction", quizId: "quiz-biology" }),
    ];
    const { topics } = computePerformance(input({ answers }));

    assert.deepEqual(topics.map((topic) => [topic.topic, topic.subjectName, topic.tally.attempted, topic.tally.accuracy]), [
      ["Refraction", "Optics", 4, 0.75],
      ["Accommodation", "Optics", 3, 1 / 3],
      ["Refraction", "Biology", 2, 1],
    ]);
  });

  it("counts answers with no topic instead of inventing one", () => {
    const answers = [...run("cx", { topic: null }), ...run("c", { topic: "  " }), ...run("ccc")];
    const performance = computePerformance(input({ answers }));

    assert.equal(performance.untaggedAnswers, 3);
    assert.deepEqual(performance.topics.map((topic) => topic.topic), ["Refraction"]);
    assert.equal(performance.overall.attempted, 6);
  });
});

describe("performance: levels and weak areas", () => {
  it("labels accuracy as strong, developing or needs review at the configured thresholds", () => {
    assert.deepEqual([PERFORMANCE.strongAccuracy, PERFORMANCE.developingAccuracy, PERFORMANCE.minAttempts], [0.8, 0.6, 3]);
    assert.equal(levelOf(tallyOf(run("ccccx"))), "strong"); // 80%
    assert.equal(levelOf(tallyOf(run("cccxx"))), "developing"); // 60%
    assert.equal(levelOf(tallyOf(run("ccccxx" + "c"))), "developing"); // 71%
    assert.equal(levelOf(tallyOf(run("ccxxx"))), "needs_review"); // 40%
    assert.equal(levelOf(tallyOf(run("cpxxx" + "p"))), "needs_review"); // 2 of 6
  });

  it("does not judge a topic on too few answers", () => {
    assert.equal(levelOf(tallyOf(run("x"))), null);
    assert.equal(levelOf(tallyOf(run("xx"))), null);
    assert.equal(levelOf(tallyOf(run("xxx"))), "needs_review");

    // One or two wrong answers are not a weak area.
    const few = computePerformance(input({ answers: [...run("x", { topic: "Myopia" }), ...run("xx", { topic: "Lenses" })] }));
    assert.deepEqual(few.weakAreas, []);
    assert.deepEqual(few.topics.map((topic) => topic.level), [null, null]);
  });

  it("flags topics with low accuracy once there is enough evidence, weakest first", () => {
    const answers = [
      ...run("xxxc", { topic: "Myopia" }), // 25%
      ...run("xcx", { topic: "Lenses" }), // 33%
      ...run("ccccx", { topic: "Refraction" }), // 80%
      ...run("ccx", { topic: "Accommodation" }), // 67%
    ];
    const { weakAreas } = computePerformance(input({ answers }));

    assert.deepEqual(weakAreas.map((area) => [area.topic, area.reason, area.tally.attempted]), [
      ["Myopia", "low_accuracy", 4],
      ["Lenses", "low_accuracy", 3],
    ]);
    assert.equal(weakAreas[0].subjectName, "Optics");
  });

  it("flags a topic that is fine overall but has gone wrong recently", () => {
    // 8 right, then 4 of the last 5 wrong: 9 of 13 overall (69%).
    const { weakAreas, topics } = computePerformance(input({ answers: run("cccccccc" + "xxcxx", { topic: "Refraction" }) }));

    assert.equal(topics[0].level, "developing");
    assert.deepEqual(weakAreas.map((area) => [area.topic, area.reason, area.recentAccuracy]), [["Refraction", "recent_decline", 0.2]]);

    // A topic with only its latest answers to go on is not "declining".
    const fresh = computePerformance(input({ answers: run("ccxxc", { topic: "Refraction" }) }));
    assert.deepEqual(fresh.weakAreas, []);
  });

  it("does not flag anything for a student who is doing well", () => {
    const performance = computePerformance(input({ answers: [...run("cccccc"), ...run("ccccc", { topic: "Lenses" })] }));
    assert.deepEqual(performance.weakAreas, []);
    assert.equal(performance.level, "strong");
  });

  it("lists questions missed more than once, and how answers split by type and difficulty", () => {
    const answers = [
      answer("incorrect", 30, { questionId: "repeat-1" }),
      answer("partial", 20, { questionId: "repeat-1" }),
      answer("correct", 10, { questionId: "repeat-1" }),
      answer("incorrect", 25, { questionId: "once" }),
      ...run("xxc", { questionType: "short_answer", difficulty: "hard" }),
      ...run("cc", { questionType: "true_false", difficulty: "easy" }),
    ];
    const { mistakes } = computePerformance(input({ answers }));

    assert.deepEqual(mistakes.repeated, [{ questionId: "repeat-1", misses: 2, attempts: 3 }]);
    assert.deepEqual(mistakes.byType.map((row) => [row.type, row.tally.attempted, row.tally.accuracy]), [
      ["multiple_choice", 4, 0.375],
      ["true_false", 2, 1],
      ["short_answer", 3, 1 / 3],
    ]);
    assert.deepEqual(mistakes.byDifficulty.map((row) => [row.difficulty, row.tally.attempted]), [["easy", 2], ["medium", 4], ["hard", 3]]);
  });
});

describe("performance: trend", () => {
  it("reports improving when recent answers are clearly better than earlier ones", () => {
    const trend = trendOf(run("xxxcx" + "ccccx")); // 20% then 80%
    assert.deepEqual(trend, { direction: "improving", previous: 0.2, recent: 0.8 });
  });

  it("reports declining when recent answers are clearly worse", () => {
    const trend = trendOf(run("ccccc" + "cxxxx")); // 100% then 20%
    assert.deepEqual(trend, { direction: "declining", previous: 1, recent: 0.2 });
  });

  it("reports stable when the difference is small", () => {
    assert.equal(trendOf(run("ccxcc" + "cxccc")).direction, "stable"); // 80% and 80%
    // A change smaller than the threshold is not a trend: 70% then 75%.
    const slight = trendOf(run("cccccccxxx" + "cccccccpxx"));
    assert.equal(slight.direction, "stable");
  });

  it("reports insufficient data rather than guessing from a handful of answers", () => {
    for (const pattern of ["", "c", "xc", "xxxcccc"]) {
      assert.deepEqual(trendOf(run(pattern)), { direction: "insufficient", previous: null, recent: null }, pattern);
    }
    // Eight answers are the fewest that fill both halves.
    assert.equal(trendOf(run("xxxx" + "cccc")).direction, "improving");
    assert.equal(PERFORMANCE.trendMinPerWindow, 4);
  });

  it("compares by time answered, not by the order records arrive in", () => {
    const shuffled = [...run("xxxxx" + "ccccc")].reverse();
    assert.equal(trendOf(shuffled).direction, "improving");
  });

  it("only compares the most recent answers, so old history does not hide a change", () => {
    const trend = trendOf(run("x".repeat(60) + "c".repeat(10) + "x".repeat(10)));
    assert.deepEqual(trend, { direction: "declining", previous: 1, recent: 0 });
  });

  it("gives each subject its own trend", () => {
    const answers = [...run("xxxxcccc"), ...run("ccccxxxx", { quizId: "quiz-biology", topic: "Cells" })];
    const { subjects, trend } = computePerformance(input({ answers }));
    const by = Object.fromEntries(subjects.map((subject) => [subject.name, subject.trend.direction]));

    assert.deepEqual(by, { Optics: "improving", Biology: "declining" });
    assert.equal(trend.direction, "stable");
  });
});

describe("performance: flashcards and activity", () => {
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  it("reports flashcard reviews as activity, separately from quiz accuracy", () => {
    const reviews = [
      { rating: "again" as const, reviewedAt: hoursAgo(2) },
      { rating: "good" as const, reviewedAt: hoursAgo(3) },
      { rating: "good" as const, reviewedAt: hoursAgo(30) },
      { rating: "easy" as const, reviewedAt: hoursAgo(24 * 20) },
    ];
    const performance = computePerformance(input({ reviews, reviewsTotal: 57 }));

    assert.deepEqual(performance.flashcards, { reviewed: 57, reviewedRecently: 3, ratings: { again: 1, hard: 0, good: 2, easy: 1 }, lastReviewedAt: hoursAgo(2) });
    // Reviewing cards does not create quiz results.
    assert.equal(performance.hasQuizData, false);
    assert.equal(performance.overall.accuracy, null);
    assert.deepEqual(performance.weakAreas, []);
  });

  it("counts the days the student was active in the last week", () => {
    const answers = [answer("correct", 1), answer("correct", 2), answer("incorrect", 26), answer("correct", 24 * 9)];
    const reviews = [{ rating: "good" as const, reviewedAt: hoursAgo(50) }];
    const { activity } = computePerformance(input({ answers, reviews, reviewsTotal: 1 }));

    assert.deepEqual(activity, { days: 7, activeDays: 3, answers: 3, reviews: 1, lastActiveAt: hoursAgo(1) });
  });
});
