import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnswerResult } from "@/lib/ai/practice/types";
import { answerQuestion, completeAttempt, startAttempt } from "@/lib/ai/practice/quiz-service";
import { computePerformance, type AnswerRecord, type AttemptRecord, type QuizRecord } from "@/lib/performance/compute";
import { PERFORMANCE, READINESS } from "@/lib/performance/config";
import { computeReadiness, statusOf, type ReadinessInput } from "@/lib/performance/readiness";
import { createPastSession, submitExam } from "@/lib/past-questions/sessions";
import { pastDeps, pastWorld, quizDeps } from "./past-fakes";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUIZZES: QuizRecord[] = [
  { id: "quiz", title: "Anatomy quiz", subjectId: "anatomy", mode: "quiz" },
  { id: "past", title: "Practice: Anatomy 2022", subjectId: "anatomy", mode: "past_practice" },
  { id: "exam", title: "Exam: Anatomy 2022", subjectId: "anatomy", mode: "exam" },
];

let counter = 0;
// Answers written as a string, oldest first: "c" correct, "p" partial, "x" incorrect.
function run(pattern: string, quizId: string, topic: string | null = "Thorax", startHoursAgo = 48): AnswerRecord[] {
  const results: Record<string, AnswerResult> = { c: "correct", p: "partial", x: "incorrect" };
  return [...pattern].map((letter, index) => ({
    questionId: `q-${++counter}`,
    quizId,
    result: results[letter],
    answeredAt: new Date(NOW.getTime() - (startHoursAgo - index / 100) * 3_600_000).toISOString(),
    questionType: "multiple_choice",
    difficulty: null,
    topic,
  }));
}

const examAttempt = (score: number, total: number, hoursAgo: number, id = `attempt-${++counter}`): AttemptRecord => ({
  id, quizId: "exam", score, total, completedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
});

function readiness(overrides: Partial<Omit<ReadinessInput, "performance">> = {}) {
  const input = { answers: [] as AnswerRecord[], attempts: [] as AttemptRecord[], quizzes: QUIZZES, pastTopics: [] as string[], now: NOW, ...overrides };
  const performance = computePerformance({ ...input, subjects: [{ id: "anatomy", name: "Anatomy" }], reviews: [], reviewsTotal: 0 });
  return { result: computeReadiness({ ...input, performance }), performance };
}

const part = (result: ReturnType<typeof computeReadiness>, key: string) => result.parts.find((item) => item.key === key)!;

describe("exam readiness: the score", () => {
  it("gives no score, and promises nothing, before there is enough practice", () => {
    const { result } = readiness();
    assert.equal(result.score, null);
    assert.equal(result.status, null);
    assert.equal(result.answersNeeded, READINESS.minAnswers);
    assert.ok(result.parts.every((item) => item.value === null && item.share === 0));
    assert.match(result.recommendation, /Answer 10 more questions to see your readiness/);

    // Nine answers is still not enough, however good they are.
    const nine = readiness({ answers: run("ccccccccc", "past") }).result;
    assert.equal(nine.score, null);
    assert.equal(nine.answersNeeded, 1);
  });

  it("is the weighted average of its parts, by the documented formula", () => {
    const { result } = readiness({
      // Past questions: 16 of 20 right = 0.80. Quizzes: 6 of 10 right = 0.60.
      // (The misses come first, so neither topic is flagged as slipping recently.)
      answers: [...run("xxxxcccccccccccccccc", "past", "Thorax"), ...run("xxxxcccccc", "quiz", "Abdomen")],
      // Exams: 14/20 and 18/20 → mean 0.80.
      attempts: [examAttempt(14, 20, 30), examAttempt(18, 20, 10)],
      // Two topics in the past questions, one of them practised → 0.50.
      pastTopics: ["Thorax", "Thorax", "Pelvis", "Uncategorized"],
    });

    assert.equal(part(result, "exams").value, 0.8);
    assert.equal(part(result, "pastQuestions").value, 0.8);
    assert.equal(part(result, "quizzes").value, 0.6);
    assert.equal(part(result, "coverage").value, 0.5);
    // All of it on two days of the last fourteen: 2 ÷ 7.
    assert.equal(part(result, "consistency").value, 1 / 7);
    assert.deepEqual(result.parts.map((item) => item.share), [0.35, 0.25, 0.2, 0.1, 0.1]);

    // 0.35×0.80 + 0.25×0.80 + 0.20×0.60 + 0.10×0.50 + 0.10×(1/7) = 0.6643 → 66, no weak topics.
    assert.equal(result.penalty, 0);
    assert.equal(result.score, 66);
    assert.equal(result.status, "developing");
  });

  it("leaves out a part with no data and rescales the rest, instead of counting it as zero", () => {
    // Only past-question practice: 9 of 10 right, on one day.
    const { result } = readiness({ answers: run("cccccccccx", "past") });

    assert.deepEqual(result.parts.map((item) => [item.key, item.value === null]), [["exams", true], ["pastQuestions", false], ["quizzes", true], ["coverage", true], ["consistency", false]]);
    // Weights 0.25 and 0.10 become 5/7 and 2/7.
    assert.ok(Math.abs(part(result, "pastQuestions").share - 0.25 / 0.35) < 1e-9);
    assert.ok(Math.abs(result.parts.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9);
    // (0.25×0.9 + 0.10×(1/7)) ÷ 0.35 = 0.6837 → 68.
    assert.equal(result.score, 68);
  });

  it("needs a minimum number of answers before an accuracy counts", () => {
    const { result } = readiness({ answers: [...run("cccccccc", "past"), ...run("xx", "quiz")] });
    // Two quiz answers say nothing reliable, so they are not part of the score.
    assert.equal(part(result, "quizzes").value, null);
    assert.match(part(result, "quizzes").detail, /Needs 5 quiz answers/);
    assert.equal(part(result, "pastQuestions").value, 1);
  });

  it("takes points off for topics flagged as needing review, up to a limit", () => {
    const strong = run("cccccccccccccccccccc", "past", "Thorax");
    const weakTopic = (topic: string) => run("x".repeat(PERFORMANCE.minAttempts), "past", topic);

    const none = readiness({ answers: strong });
    const one = readiness({ answers: [...strong, ...weakTopic("Pelvis")] });
    assert.equal(none.result.penalty, 0);
    assert.equal(one.performance.weakAreas.length, 1);
    assert.equal(one.result.penalty, READINESS.weakAreaPenalty);
    assert.deepEqual(one.result.reviewAreas, ["Pelvis"]);

    const many = readiness({ answers: [...strong, ...["A", "B", "C", "D", "E", "F", "G"].flatMap((name) => weakTopic(`Topic ${name}`))] });
    assert.equal(many.performance.weakAreas.length, 7);
    assert.equal(many.result.penalty, READINESS.maxWeakAreaPenalty);
    assert.equal(many.result.reviewAreas.length, READINESS.maxAreas);
  });

  it("stays between 0 and 100", () => {
    const worst = readiness({ answers: ["A", "B", "C", "D", "E", "F"].flatMap((name) => run("xxx", "past", name)), attempts: [examAttempt(0, 20, 5)] });
    assert.equal(worst.result.score, 0);
    const best = readiness({
      answers: Array.from({ length: 8 }, (_, day) => run("ccc", "past", "Thorax", 24 * day + 2)).flat(),
      attempts: [examAttempt(20, 20, 5)],
      pastTopics: ["Thorax"],
    });
    assert.equal(best.result.score, 100);
  });

  it("uses the configured thresholds for its status", () => {
    assert.deepEqual([100, 80, 79, 60, 59, 0].map(statusOf), ["strong", "strong", "developing", "developing", "needs_review", "needs_review"]);
    assert.equal(READINESS.strongScore, 80);
    assert.equal(READINESS.developingScore, 60);
    assert.equal(Object.values(READINESS.weights).reduce((sum, weight) => sum + weight, 0).toFixed(6), "1.000000");
  });

  it("counts only the most recent exam simulations", () => {
    const attempts = [examAttempt(0, 10, 700), ...Array.from({ length: READINESS.examWindow }, (_, index) => examAttempt(9, 10, 100 - index))];
    const { result } = readiness({ answers: run("cccccccccc", "exam"), attempts });
    assert.equal(part(result, "exams").value, 0.9);
    assert.deepEqual(result.exams, { completed: 6, latestPercent: 90, averagePercent: 90, latestAt: attempts[attempts.length - 1].completedAt });
  });
});

describe("exam readiness: the breakdown", () => {
  it("reports past-question performance across practice and exams together", () => {
    const { result } = readiness({ answers: [...run("cccccccx", "past"), ...run("ccxx", "exam"), ...run("xxxxx", "quiz")] });
    // 7 of 8 in practice and 2 of 4 in an exam; the quiz answers are not past questions.
    assert.deepEqual(result.pastQuestions, { answered: 12, accuracy: 9 / 12 });
  });

  it("compares the last period with the one before it, in points", () => {
    const earlier = run("ccccxxxxxx", "past", "Thorax", 24 * 20);
    const later = run("ccccccccxx", "past", "Thorax", 24 * 3);
    const { result } = readiness({ answers: [...earlier, ...later] });
    assert.deepEqual(result.trend, { change: 40, recent: 0.8, previous: 0.4, days: READINESS.periodDays });

    // With too few answers in either period, no change is claimed.
    const thin = readiness({ answers: [...run("cc", "past", "Thorax", 24 * 20), ...later] }).result;
    assert.deepEqual([thin.trend.change, thin.trend.recent, thin.trend.previous], [null, null, null]);
  });

  it("lists strong areas and areas to review from the student's own results", () => {
    const { result } = readiness({ answers: [...run("cccccccccc", "past", "Thorax"), ...run("xxxx", "past", "Pelvis"), ...run("ccx", "past", "Abdomen")] });
    assert.deepEqual(result.strongAreas, ["Thorax"]);
    assert.deepEqual(result.reviewAreas, ["Pelvis"]);
  });

  it("recommends what the figures point to, and never promises a result", () => {
    const weak = readiness({ answers: [...run("cccccccccc", "past", "Thorax"), ...run("xxxx", "past", "Pelvis"), ...run("xxxx", "past", "Abdomen")], attempts: [examAttempt(15, 20, 5)] }).result;
    assert.equal(weak.recommendation, "Focus on Pelvis and Abdomen before taking another full exam simulation.");

    const noExam = readiness({ answers: run("cccccccccc", "past", "Thorax") }).result;
    assert.match(noExam.recommendation, /Try a timed exam simulation/);

    const uncovered = readiness({ answers: run("cccccccccc", "past", "Thorax"), attempts: [examAttempt(18, 20, 5)], pastTopics: ["Thorax", "Pelvis", "Abdomen", "Head"] }).result;
    assert.equal(uncovered.recommendation, "You have practised 1 of the 4 topics in your past questions. Try the ones you haven't touched yet.");

    const steady = readiness({
      answers: Array.from({ length: 8 }, (_, day) => run("ccc", "past", "Thorax", 24 * day + 2)).flat(),
      attempts: [examAttempt(19, 20, 5)],
      pastTopics: ["Thorax"],
    }).result;
    assert.equal(steady.status, "strong");
    assert.match(steady.recommendation, /^Your current practice performance suggests you are well prepared/);

    for (const { recommendation } of [weak, noExam, uncovered, steady]) {
      assert.doesNotMatch(recommendation, /you will pass|guarantee|certain|definitely/i);
    }
  });

  it("links an exam in the recent list to its own page", () => {
    const attempt = examAttempt(8, 10, 2, "11111111-1111-4111-8111-111111111111");
    const quizAttempt: AttemptRecord = { id: "22222222-2222-4222-8222-222222222222", quizId: "quiz", score: 3, total: 5, completedAt: new Date(NOW.getTime() - 3_600_000).toISOString() };
    const { performance } = readiness({ attempts: [attempt, quizAttempt] });
    assert.deepEqual(performance.recentQuizzes.map((quiz) => quiz.href), ["/quizzes/quiz", "/exam/11111111-1111-4111-8111-111111111111"]);
  });
});

describe("past questions in the existing performance system", () => {
  // Two students each practise a paper; A gets the Thorax questions wrong.
  async function practised() {
    const w = pastWorld();
    const deps = { a: pastDeps(w, USER_A), b: pastDeps(w, USER_B) };
    const subjectA = w.db.addSubject(USER_A, "Anatomy");
    const subjectB = w.db.addSubject(USER_B, "Anatomy");
    const questions = (topic: string, count: number) => Array.from({ length: count }, () => ({ topic }));
    const setA = w.db.addSet(USER_A, subjectA.id, "Anatomy 2022", [...questions("Thorax", 4), ...questions("Abdomen", 4)]);
    w.db.addSet(USER_B, subjectB.id, "B's Anatomy", questions("Thorax", 4));

    const session = await createPastSession({ kind: "practice", setIds: [setA.id], selection: "all", count: "all" }, deps.a);
    const started = await startAttempt(session.quiz.id, quizDeps(w, USER_A));
    for (const [index, question] of started.questions.entries()) {
      // Option 0 is correct; the four Thorax questions are answered wrongly.
      await answerQuestion({ attemptId: started.attempt.id, questionId: question.id, answer: index < 4 ? 1 : 0 }, quizDeps(w, USER_A));
    }
    await completeAttempt(started.attempt.id, quizDeps(w, USER_A));

    const other = await createPastSession({ kind: "exam", count: "all" }, deps.b);
    const copies = await w.db.as(USER_B).getQuestions(other.quiz.id);
    await submitExam({ attemptId: other.attempt!.id, answers: Object.fromEntries(copies.map((q) => [q.id, 0])) }, deps.b);
    return { w, deps, setA, subjectA };
  }

  // Performance worked out from one student's rows, as getPerformance() does.
  function performanceOf(w: Awaited<ReturnType<typeof practised>>["w"], userId: string) {
    const db = w.db.quizzes;
    const mine = <T extends { userId: string }>(rows: T[]) => rows.filter((row) => row.userId === userId);
    const question = new Map(db.questions.map((q) => [q.id, q]));
    const input = {
      answers: mine(db.answers).map((answer): AnswerRecord => ({
        questionId: answer.questionId, quizId: question.get(answer.questionId)!.quizId, result: answer.result, answeredAt: answer.answeredAt,
        questionType: question.get(answer.questionId)!.type, difficulty: null, topic: question.get(answer.questionId)!.topic,
      })),
      attempts: mine(db.attempts).filter((a) => a.completedAt).map((a): AttemptRecord => ({ id: a.id, quizId: a.quizId, score: a.score ?? 0, total: a.totalQuestions, completedAt: a.completedAt! })),
      quizzes: mine(db.quizzes).map((quiz): QuizRecord => ({ id: quiz.id, title: quiz.title, subjectId: quiz.subjectId, mode: quiz.mode })),
      now: w.db.now(),
    };
    const performance = computePerformance({ ...input, subjects: mine(db.subjects).map(({ id, name }) => ({ id, name })), reviews: [], reviewsTotal: 0 });
    const pastTopics = w.db.questions.filter((q) => q.userId === userId && q.topic).map((q) => q.topic!);
    return { performance, readiness: computeReadiness({ ...input, performance, pastTopics }) };
  }

  it("flags a weak topic from past-question answers, with no extra wiring", async () => {
    const { w } = await practised();
    const { performance } = performanceOf(w, USER_A);

    assert.equal(performance.overall.attempted, 8);
    assert.deepEqual(performance.weakAreas.map((area) => [area.topic, area.subjectName, area.reason, area.tally.accuracy]), [["Thorax", "Anatomy", "low_accuracy", 0]]);
    assert.deepEqual(performance.topics.map((topic) => [topic.topic, topic.level]), [["Abdomen", "strong"], ["Thorax", "needs_review"]]);
  });

  it("turns that weak topic straight into a practice session on it", async () => {
    const { w, deps } = await practised();
    w.weakTopics = performanceOf(w, USER_A).performance.weakAreas.map((area) => area.topic);

    const review = await createPastSession({ kind: "practice", selection: "weak_topics", count: 10 }, deps.a);
    const copies = await w.db.as(USER_A).getQuestions(review.quiz.id);
    assert.equal(review.delivered, 4);
    assert.ok(copies.every((question) => question.topic === "Thorax"));
  });

  it("keeps each student's performance and readiness to their own answers", async () => {
    const { w } = await practised();
    const a = performanceOf(w, USER_A);
    const b = performanceOf(w, USER_B);

    // A: 4 of 8 in practice. B: 4 of 4 in one exam. Neither sees the other's.
    assert.deepEqual([a.performance.overall.attempted, a.performance.overall.correct, a.readiness.exams.completed], [8, 4, 0]);
    assert.deepEqual([b.performance.overall.attempted, b.performance.overall.correct, b.readiness.exams.completed], [4, 4, 1]);
    assert.deepEqual(b.performance.weakAreas, []);
    assert.deepEqual(b.readiness.pastQuestions, { answered: 4, accuracy: 1 });
    assert.equal(a.readiness.pastQuestions.accuracy, 0.5);
    // Only A has a topic to review. Neither has answered enough for a score yet.
    assert.deepEqual([a.readiness.reviewAreas, b.readiness.reviewAreas], [["Thorax"], []]);
    assert.deepEqual([a.readiness.score, a.readiness.answersNeeded, b.readiness.score, b.readiness.answersNeeded], [null, 2, null, 6]);

    // And one student's store finds nothing of the other's.
    const storeB = w.db.as(USER_B);
    const aQuiz = w.db.quizzes.quizzes.find((quiz) => quiz.userId === USER_A)!;
    const aAttempt = w.db.quizzes.attempts.find((attempt) => attempt.userId === USER_A)!;
    assert.equal(await storeB.getQuiz(aQuiz.id), null);
    assert.equal(await storeB.getAttempt(aAttempt.id), null);
    assert.deepEqual(await storeB.getQuestions(aQuiz.id), []);
    assert.deepEqual(await storeB.getAnswers(aAttempt.id), []);
    assert.equal((await storeB.listSets()).length, 1);
    assert.equal((await storeB.getHistory()).size, 4);
  });
});
