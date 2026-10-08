import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtractedDocument } from "@/lib/ai/documents/types";
import { PRACTICE_ERRORS, PracticeError, toResult } from "@/lib/ai/practice/errors";
import { buildExplainMessage } from "@/lib/ai/practice/explain";
import { answerQuestion, completeAttempt, startAttempt, toFeedback } from "@/lib/ai/practice/quiz-service";
import { TutorError } from "@/lib/ai/tutor/errors";
import { ANALYSIS_INSTRUCTIONS, cleanTopic, readAnalysis, topicFrequency } from "@/lib/past-questions/analysis";
import { PAST, PAST_QUESTION_TYPES, UNCATEGORIZED } from "@/lib/past-questions/config";
import { parseSetDetails } from "@/lib/past-questions/details";
import { parsePastQuestions } from "@/lib/past-questions/parser";
import { analyzeSet, processPastQuestionSet } from "@/lib/past-questions/process";
import { numberListItems } from "@/lib/past-questions/read";
import { cleanExamState, createPastSession, getExamReview, saveExamProgress, secondsRemaining, selectQuestions, submitExam, toExamQuestion, type SessionCriteria } from "@/lib/past-questions/sessions";
import type { SessionQuestion } from "@/lib/past-questions/store";
import type { ExamAttempt, PastQuestion } from "@/lib/past-questions/types";
import { makeDocx, makePdf, makePptx } from "./fixtures";
import { pastDeps, pastQuestion, pastWorld, processingDeps, quizDeps, type PastWorld } from "./past-fakes";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PracticeError, `expected a PracticeError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

// A paper as the extractors hand it over: one unit per page, one block per
// blank-line-separated paragraph.
function paper(...pages: string[]): ExtractedDocument {
  return {
    units: pages.map((text, index) => ({
      pageNumber: pages.length > 1 ? index + 1 : undefined,
      blocks: text.trim().split(/\n{2,}/).map((paragraph) => ({ kind: "paragraph" as const, text: paragraph.trim() })),
    })),
  };
}

const parse = (text: string, options = {}) => parsePastQuestions(paper(text), options);

// ============================================================ extraction

describe("question extraction: layouts", () => {
  it("reads multiple-choice questions with lettered options", () => {
    const { questions, structured, raw } = parse(`
ANATOMY FINAL EXAMINATION

1. Which cranial nerve supplies the superior oblique muscle?
A. Oculomotor
B. Trochlear
C. Abducens
D. Facial

2. The optic nerve is cranial nerve number:
A. I
B. II
C. III
D. IV
`);
    assert.equal(structured, 2);
    assert.equal(raw, 0);
    assert.deepEqual(questions[0], {
      number: "1", type: "multiple_choice", question: "Which cranial nerve supplies the superior oblique muscle?",
      options: ["Oculomotor", "Trochlear", "Abducens", "Facial"], correctAnswer: null, explanation: null, year: null, page: null, slide: null,
    });
    assert.deepEqual(questions[1].options, ["I", "II", "III", "IV"]);
  });

  it("accepts the common ways of numbering and lettering", () => {
    const { questions } = parse(`
Q1. First question here?
(a) one
(b) two
(c) three

2) Second question here?
a) one
b) two

Question 3: Third question here?
A) one
B) two
C) three
D) four
E) five

4 - Fourth question here?
A. yes it is
B. no it is not
`);
    assert.deepEqual(questions.map((q) => [q.number, q.type, q.options.length]), [["1", "multiple_choice", 3], ["2", "multiple_choice", 2], ["3", "multiple_choice", 5], ["4", "multiple_choice", 2]]);
  });

  it("splits options that share a line, on the question's line or the next", () => {
    const { questions } = parse(`
1. The powerhouse of the cell is the: A. nucleus B. mitochondrion C. ribosome D. Golgi body
2. Which gas do plants take in?
A. Oxygen  B. Nitrogen  C. Carbon dioxide  D. Helium
`);
    assert.equal(questions[0].question, "The powerhouse of the cell is the:");
    assert.deepEqual(questions[0].options, ["nucleus", "mitochondrion", "ribosome", "Golgi body"]);
    assert.deepEqual(questions[1].options, ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"]);
  });

  it("reads written questions with no options as short answers", () => {
    const { questions } = parse(`
1. Define osmosis.
2. State two differences between arteries and veins.
3. Describe the structure of the nephron
and explain how it forms urine.
`);
    assert.deepEqual(questions.map((q) => q.type), ["short_answer", "short_answer", "short_answer"]);
    assert.equal(questions[2].question, "Describe the structure of the nephron and explain how it forms urine.");
    assert.ok(questions.every((q) => q.options.length === 0 && q.correctAnswer === null));
  });

  it("separates sub-questions written as 1a, 1b and as (a), (b) under a question", () => {
    const direct = parse(`
1a. Define diffusion.
1b. Give two examples of diffusion in the body.
2(a) What is a synapse?
2(b) Name one neurotransmitter.
`);
    assert.deepEqual(direct.questions.map((q) => q.number), ["1a", "1b", "2a", "2b"]);

    const nested = parse(`
1. The diagram shows a section through the heart.
(a) Name the chamber labelled X.
(b) Explain why its wall is thicker than that of chamber Y. (4 marks)
(c) State the function of the valve labelled Z.
2. Define homeostasis.
`);
    assert.deepEqual(nested.questions.map((q) => [q.number, q.type]), [["1a", "short_answer"], ["1b", "short_answer"], ["1c", "short_answer"], ["2", "short_answer"]]);
    assert.equal(nested.questions[0].question, "The diagram shows a section through the heart.\nName the chamber labelled X.");
  });

  it("recognises true/false questions", () => {
    const { questions } = parse(`
1. The liver produces bile. (True/False)
2. Insulin raises blood glucose.
A. True
B. False
Answer: B
`);
    assert.deepEqual(questions.map((q) => q.type), ["true_false", "true_false"]);
    assert.equal(questions[1].correctAnswer, false);
    assert.deepEqual(questions[1].options, []);
  });

  it("keeps a question whole when it runs over a page break", () => {
    const result = parsePastQuestions(
      paper(
        "1. Which of these is a\nfeature of the proximal tubule?\nA. Brush border\nB. Podocytes",
        "C. Macula densa\nD. Principal cells\n\n2. The loop of Henle is found in the:\nA. cortex only\nB. medulla",
      ),
    );
    assert.equal(result.structured, 2);
    assert.equal(result.questions[0].question, "Which of these is a feature of the proximal tubule?");
    assert.deepEqual(result.questions[0].options, ["Brush border", "Podocytes", "Macula densa", "Principal cells"]);
    // A question is cited where it starts.
    assert.equal(result.questions[0].page, 1);
    assert.equal(result.questions[1].page, 2);
  });

  it("does not mistake a numbered list inside a question for new questions", () => {
    const { questions, structured } = parse(`
1. Which of the following statements about the kidney are correct?
1. It filters blood.
2. It produces insulin.
3. It regulates blood pressure.
A. 1 and 2 only
B. 1 and 3 only
C. 2 and 3 only
D. 1, 2 and 3
2. The functional unit of the kidney is the:
A. nephron
B. neuron
`);
    assert.equal(structured, 2);
    assert.match(questions[0].question, /are correct\? 1\. It filters blood\. 2\. It produces insulin\. 3\. It regulates blood pressure\.$/);
    assert.deepEqual(questions[0].options, ["1 and 2 only", "1 and 3 only", "2 and 3 only", "1, 2 and 3"]);
    assert.equal(questions[1].number, "2");
  });

  it("does not read e.g. or a stray page number as part of a question", () => {
    const { questions } = parse(`
1. Which is a fat-soluble vitamin?
A. Vitamin C
B. Vitamin B12
C. Vitamin K
D. Folate
e.g. found in leafy vegetables
Page 3 of 9
2. Which is a water-soluble vitamin?
A. Vitamin A
B. Vitamin C
`);
    assert.equal(questions[0].options.length, 4);
    assert.equal(questions[0].options[3], "Folate e.g. found in leafy vegetables");
    assert.equal(questions[1].number, "2");
  });

  it("takes each question's year from the paper's own headings", () => {
    const { questions } = parse(
      `
WAEC BIOLOGY 2021

1. First question of the first paper?
A. yes
B. no

WAEC BIOLOGY 2022

1. First question of the second paper?
A. yes
B. no
`,
      { year: 2020 },
    );
    assert.deepEqual(questions.map((q) => q.year), [2021, 2022]);
    // A collection with no dated headings uses the year it was given.
    assert.deepEqual(parse("1. Is this dated?\nA. yes\nB. no", { year: 2019 }).questions.map((q) => q.year), [2019]);
    assert.deepEqual(parse("1. Is this dated?\nA. yes\nB. no").questions.map((q) => q.year), [null]);
  });
});

describe("question extraction: answers", () => {
  const BODY = `
1. Which organ produces insulin?
A. Liver
B. Pancreas
C. Kidney
D. Spleen

2. Red blood cells are produced in the:
A. bone marrow
B. liver
C. heart
D. lungs

3. Enzymes are proteins. True or False?
`;

  it("never invents an answer when the paper has no key", () => {
    const { questions, withAnswers } = parse(BODY);
    assert.equal(withAnswers, 0);
    assert.ok(questions.every((q) => q.correctAnswer === null));
  });

  it("matches an answer key at the end to the questions by number", () => {
    const { questions, withAnswers, structured } = parse(`${BODY}\nANSWERS\n1. B\n2. A\n3. True\n`);
    assert.equal(structured, 3);
    assert.equal(withAnswers, 3);
    assert.deepEqual(questions.map((q) => q.correctAnswer), ["Pancreas", "bone marrow", true]);
  });

  it("reads a key written across one line, with or without a heading", () => {
    assert.deepEqual(parse(`${BODY}\nAnswer Key:\n1.B 2.A 3.T\n`).questions.map((q) => q.correctAnswer), ["Pancreas", "bone marrow", true]);
    assert.deepEqual(parse(`${BODY}\n1. B\n2. A\n3. F\n`).questions.map((q) => q.correctAnswer), ["Pancreas", "bone marrow", false]);
  });

  it("reads a key that starts on the same line as its heading", () => {
    const keyed = parse(`${BODY}\nAnswers: 1.B 2.A\n3. T\n`);
    assert.deepEqual(keyed.questions.map((q) => q.correctAnswer), ["Pancreas", "bone marrow", true]);
    // The key did not leak into the last question's wording.
    assert.equal(keyed.questions[2].question, "Enzymes are proteins. True or False?");
    assert.equal(keyed.questions.length, 3);
  });

  it("reads the short ways an answer is written under a question", () => {
    const { questions } = parse(`
1. Which organ produces insulin?
A. Liver
B. Pancreas
Ans. B
2. Which organ stores bile?
A. Gall bladder
B. Spleen
The correct answer is A
3. Answer the following in one sentence: what is a hormone?
`);
    assert.deepEqual(questions.map((q) => q.correctAnswer), ["Pancreas", "Gall bladder", null]);
    assert.deepEqual(questions[0].options, ["Liver", "Pancreas"]);
    // "Answer the following…" is the question's own wording, not an answer.
    assert.equal(questions[2].question, "Answer the following in one sentence: what is a hormone?");
  });

  it("reads an answer and explanation given straight after a question", () => {
    const { questions } = parse(`
1. Which organ produces insulin?
A. Liver
B. Pancreas
Answer: B
Explanation: The beta cells of the pancreatic islets
secrete insulin.

2. Define osmosis.
Ans: The movement of water across a partially permeable membrane.
`);
    assert.equal(questions[0].correctAnswer, "Pancreas");
    assert.equal(questions[0].explanation, "The beta cells of the pancreatic islets secrete insulin.");
    assert.equal(questions[1].correctAnswer, "The movement of water across a partially permeable membrane.");
  });

  it("reads written answers from a marking scheme", () => {
    const { questions } = parse(`
1. Define osmosis.
2. Name the pigment in red blood cells.

MARKING SCHEME
1. Movement of water from a dilute to a concentrated
solution through a partially permeable membrane.
2. Haemoglobin
`);
    assert.equal(questions.length, 2);
    assert.equal(questions[0].correctAnswer, "Movement of water from a dilute to a concentrated solution through a partially permeable membrane.");
    assert.equal(questions[1].correctAnswer, "Haemoglobin");
  });

  it("leaves a question unanswered when the key names an option that does not exist", () => {
    const { questions } = parse(`
1. Pick one of two?
A. this
B. that

ANSWERS
1. D
2. A
`);
    assert.equal(questions.length, 1);
    assert.equal(questions[0].correctAnswer, null);
  });

  it("applies each paper's key to that paper only", () => {
    const { questions } = parse(`
PAPER 2021
1. First of 2021?
A. right
B. wrong
2. Second of 2021?
A. wrong
B. right
ANSWERS
1. A
2. B

PAPER 2022
1. First of 2022?
A. wrong
B. right
ANSWERS
1. B
`);
    assert.deepEqual(questions.map((q) => [q.year, q.number, q.correctAnswer]), [[2021, "1", "right"], [2021, "2", "right"], [2022, "1", "right"]]);
  });

  it("gives no answers when repeated numbers make a single key ambiguous", () => {
    const { questions } = parse(`
SECTION A
1. First of section A?
A. one
B. two
SECTION B
1. First of section B?
A. one
B. two

ANSWERS
1. A
2. B
`);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions.map((q) => q.correctAnswer), [null, null]);
  });

  it("does not match a key by number when the numbers were not printed in the paper", () => {
    const text = "1. Which is larger?\nA. the sun\nB. the moon\n\nANSWERS\n1. A";
    assert.equal(parse(text).questions[0].correctAnswer, "the sun");
    assert.equal(parse(text, { trustNumbers: false }).questions[0].correctAnswer, null);
  });
});

describe("question extraction: when it cannot be sure", () => {
  it("keeps text with no recognisable questions exactly as it was read", () => {
    const text = "Discuss the role of the kidney in homeostasis, with reference to water balance and blood pressure.\n\nYour answer should refer to at least three hormones.";
    const { questions, structured, raw } = parse(text);
    assert.equal(structured, 0);
    assert.equal(raw, 1);
    assert.equal(questions[0].type, "raw");
    assert.equal(questions[0].correctAnswer, null);
    assert.equal(questions[0].question, "Discuss the role of the kidney in homeostasis, with reference to water balance and blood pressure.\nYour answer should refer to at least three hormones.");
  });

  it("keeps a malformed question as raw text instead of guessing its structure", () => {
    const { questions } = parse(`
1. Which is correct?
A. Same
B. Same
C. Different
2. Is this one fine?
A. yes
B. no
3. ??
`);
    // Two identical options cannot be told apart when marking.
    assert.equal(questions[0].type, "raw");
    assert.equal(questions[0].question, "1. Which is correct?\nA. Same\nB. Same\nC. Different");
    assert.equal(questions[1].type, "multiple_choice");
    // Too short to be a question.
    assert.equal(questions[2].type, "raw");
  });

  it("does not turn a paper's numbered instructions into questions", () => {
    const { questions, structured } = parse(`
INSTRUCTIONS
1. Answer all questions.
2. Do not use a calculator.
3. Time allowed: 2 hours.

1. Which is the largest organ of the body?
A. Skin
B. Liver
`);
    assert.equal(structured, 1);
    assert.equal(questions[0].type, "raw");
    assert.match(questions[0].question, /Answer all questions/);
    assert.equal(questions[1].number, "1");
    assert.equal(questions[1].type, "multiple_choice");
  });

  it("puts Word's automatic list numbers back into the text", () => {
    const html = "<ol><li>Which is a mammal?<ol><li>Shark</li><li>Whale</li></ol></li></ol><p>Section two</p><ol><li>Which is a bird?<ol><li>Bat</li><li>Owl</li></ol></li></ol><ul><li>a note</li></ul>";
    const { html: numbered, numbered: changed } = numberListItems(html);
    assert.equal(changed, true);
    assert.equal(numbered, "<ol><li>1. Which is a mammal?<ol><li>A. Shark</li><li>B. Whale</li></ol></li></ol><p>Section two</p><ol><li>2. Which is a bird?<ol><li>A. Bat</li><li>B. Owl</li></ol></li></ol><ul><li>a note</li></ul>");
    assert.deepEqual(numberListItems("<p>1. Typed by hand</p>"), { html: "<p>1. Typed by hand</p>", numbered: false });
  });

  it("stops at the size limit and says so", () => {
    const many = Array.from({ length: PAST.maxQuestionsPerSet + 20 }, (_, index) => `${(index % 150) + 1}. Is statement ${index} true?\nA. yes\nB. no`).join("\n");
    const result = parse(many);
    assert.equal(result.truncated, true);
    assert.ok(result.questions.length <= PAST.maxQuestionsPerSet);
  });
});

// ======================================================= collections

describe("past-question collections", () => {
  it("requires nothing but a title, which falls back to the file name", () => {
    assert.deepEqual(parseSetDetails({}, "anatomy 2021"), {
      values: { title: "anatomy 2021", exam_type: null, institution: null, exam_year: null, course_code: null, description: null },
    });
    assert.deepEqual(parseSetDetails({ title: "  WAEC   Biology ", examType: "WAEC", institution: "WAEC", year: "2024", courseCode: "BIO", description: " notes " }, "x"), {
      values: { title: "WAEC Biology", exam_type: "WAEC", institution: "WAEC", exam_year: 2024, course_code: "BIO", description: "notes" },
    });
  });

  it("rejects details that are too long or a year that is not one", () => {
    const result = parseSetDetails({ title: "x".repeat(151), year: "20244", courseCode: "c".repeat(41) }, "x");
    assert.ok("fieldErrors" in result);
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), ["courseCode", "title", "year"]);
    for (const year of ["1949", "2101", "next year", "20.5"]) assert.ok("fieldErrors" in parseSetDetails({ year }, "x"), year);
  });

  it("does not offer image uploads, because there is no OCR to read them", () => {
    assert.deepEqual(PAST_QUESTION_TYPES.map((type) => type.id), ["pdf", "docx", "pptx", "ppt", "txt"]);
  });
});

const PAPER = `
PHARMACOLOGY FINAL EXAM 2023

1. Which drug is a beta blocker?
A. Atenolol
B. Amlodipine
C. Ramipril
D. Furosemide

2. Warfarin is monitored with the:
A. APTT
B. INR
C. platelet count
D. bleeding time

3. Define bioavailability.

ANSWERS
1. A
2. B
`;

describe("past-question processing", () => {
  function uploaded(text = PAPER, typeId = "txt") {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Pharmacology");
    const set = w.db.addPaper(USER_A, subject.id, "Pharmacology Final Exam 2023", text, typeId);
    return { w, subject, set };
  }

  it("reads an uploaded paper into questions owned by the student who uploaded it", async () => {
    const { w, set } = uploaded();
    w.configured = false;

    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));

    assert.deepEqual(result, { status: "ready", structured: 3, raw: 0, withAnswers: 2, analysis: "pending" });
    assert.equal(set.status, "ready");
    const questions = w.db.questionsOf(set.id);
    assert.equal(questions.length, 3);
    assert.ok(questions.every((q) => q.userId === USER_A && q.year === 2023));
    assert.deepEqual(questions.map((q) => [q.correctAnswer, q.answerSource]), [["Atenolol", "official"], ["INR", "official"], [null, "answer_unavailable"]]);
    // Reading a paper needs no AI model at all.
    assert.equal(w.model.calls.length, 0);
  });

  it("reads real PDF, Word and PowerPoint files through the existing extractors", async () => {
    const w = pastWorld();
    w.configured = false;
    const subject = w.db.addSubject(USER_A, "Biology");
    const pdf = w.db.addPaper(
      USER_A,
      subject.id,
      "PDF paper",
      makePdf([
        ["1. Which organelle makes ATP?", "A. Nucleus", "B. Mitochondrion"],
        ["C. Ribosome", "D. Lysosome", "2. DNA is double stranded. True or False?", "ANSWERS", "1. B", "2. True"],
      ]),
      "pdf",
      2024,
    );
    const docx = w.db.addPaper(
      USER_A,
      subject.id,
      "Word paper",
      makeDocx([{ heading: "BIOLOGY 2021" }, { paragraph: "1. Define an enzyme." }, { paragraph: "2. Which is a sugar?" }, { paragraph: "A. Glucose" }, { paragraph: "B. Glycine" }, { paragraph: "Answer: A" }]),
      "docx",
    );
    const pptx = w.db.addPaper(USER_A, subject.id, "Slides", makePptx([{ title: "Revision questions" }, { title: "1. Which base pairs with adenine?", body: ["A. Thymine", "B. Guanine"] }]), "pptx");

    for (const set of [pdf, docx, pptx]) assert.equal((await processPastQuestionSet(set.id, processingDeps(w, USER_A))).status, "ready", set.title);

    const fromPdf = w.db.questionsOf(pdf.id);
    assert.deepEqual(fromPdf.map((q) => [q.number, q.type, q.correctAnswer, q.page, q.year]), [["1", "multiple_choice", "Mitochondrion", 1, 2024], ["2", "true_false", true, 2, 2024]]);
    // Options that ran onto the second page stayed with their question.
    assert.deepEqual(fromPdf[0].options, ["Nucleus", "Mitochondrion", "Ribosome", "Lysosome"]);

    assert.deepEqual(w.db.questionsOf(docx.id).map((q) => [q.number, q.type, q.correctAnswer, q.year]), [["1", "short_answer", null, 2021], ["2", "multiple_choice", "Glucose", 2021]]);

    const fromSlides = w.db.questionsOf(pptx.id);
    assert.deepEqual(fromSlides.map((q) => [q.question, q.options, q.slide]), [["Which base pairs with adenine?", ["Thymine", "Guanine"], 2]]);
  });

  it("refuses a scanned PDF honestly instead of inventing questions", async () => {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Biology");
    const scan = w.db.addPaper(USER_A, subject.id, "Scanned paper", makePdf([[], [], []]), "pdf");

    assert.deepEqual(await processPastQuestionSet(scan.id, processingDeps(w, USER_A)), { status: "failed", code: "OCR_UNAVAILABLE" });
    assert.match(scan.error!, /Reading scanned papers isn't available yet/);
    assert.equal(w.db.questions.length, 0);
    assert.equal(w.model.calls.length, 0);
  });

  it("does nothing for a collection that belongs to another student", async () => {
    const { w, set } = uploaded();
    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_B));
    assert.deepEqual(result, { status: "skipped" });
    assert.equal(set.status, "pending");
    assert.equal(w.db.questions.length, 0);
  });

  it("does not run twice at once on the same paper", async () => {
    const { w, set } = uploaded();
    set.status = "processing";
    assert.deepEqual(await processPastQuestionSet(set.id, processingDeps(w, USER_A)), { status: "skipped" });
  });

  it("fails honestly on an image, with no questions stored", async () => {
    const { w, set } = uploaded("not really an image", "png");
    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));
    assert.deepEqual(result, { status: "failed", code: "OCR_UNAVAILABLE" });
    assert.equal(set.status, "failed");
    assert.match(set.error!, /scan or a photo/);
    assert.equal(w.db.questions.length, 0);
  });

  it("fails with a safe message on an empty file", async () => {
    const { w, set } = uploaded("   \n  ");
    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));
    assert.equal(result.status, "failed");
    assert.match(set.error!, /No readable text/);
    assert.doesNotMatch(set.error!, /Error|at |stack/);
  });

  it("is still ready, with the raw text kept, when no questions can be picked out", async () => {
    const { w, set } = uploaded("An essay about pharmacokinetics with no numbered questions in it at all, running for a sentence or two.");
    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));
    assert.deepEqual(result, { status: "ready", structured: 0, raw: 1, withAnswers: 0, analysis: "pending" });
    assert.equal(w.db.questionsOf(set.id)[0].type, "raw");
    assert.equal(w.model.calls.length, 0);
  });
});

// ============================================================ analysis

describe("topic analysis", () => {
  async function analysed(reply: object | Error | string) {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Pharmacology");
    const set = w.db.addPaper(USER_A, subject.id, "Pharmacology Final Exam 2023", PAPER);
    w.model.queue(reply);
    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));
    return { w, set, result, questions: w.db.questionsOf(set.id) };
  }

  it("labels each question with a topic once, in one model call, and stores it", async () => {
    const { w, set, result, questions } = await analysed({
      questions: [
        { id: 1, topic: "Antihypertensives", confident: true, difficulty: "easy" },
        { id: 2, topic: "Anticoagulants", confident: true, difficulty: "medium" },
        { id: 3, topic: "Pharmacokinetics", confident: true, difficulty: "medium", answer: "The fraction of a dose that reaches the systemic circulation unchanged.", explanation: "It depends on absorption and first-pass metabolism." },
      ],
    });

    assert.equal(result.status === "ready" && result.analysis, "complete");
    assert.equal(set.analysisStatus, "complete");
    assert.deepEqual(questions.map((q) => [q.topic, q.difficulty]), [["Antihypertensives", "easy"], ["Anticoagulants", "medium"], ["Pharmacokinetics", "medium"]]);
    assert.equal(w.model.calls.length, 1);
    assert.deepEqual(w.model.limits, [PAST.analysisMaxOutputTokens]);
    assert.match(w.model.prompt(), /Subject: Pharmacology/);
    // The questions are sent as data, with only the unanswered one marked.
    assert.equal(w.model.prompt().match(/\[NEEDS ANSWER\]/g)!.length - ANALYSIS_INSTRUCTIONS.match(/\[NEEDS ANSWER\]/g)!.length, 1);

    // Running it again finds nothing left to do and calls no model.
    assert.deepEqual(await analyzeSet(set.id, processingDeps(w, USER_A)), { status: "complete", analyzed: 0, remaining: 0 });
    assert.equal(w.model.calls.length, 1);
  });

  it("labels an answer Ari worked out as Ari's, and never replaces the paper's own", async () => {
    const { questions } = await analysed({
      questions: [
        // The model tries to "correct" an official answer. It is ignored.
        { id: 1, topic: "Antihypertensives", confident: true, answer: "D", explanation: "Wrong on purpose." },
        { id: 2, topic: "Anticoagulants", confident: true },
        { id: 3, topic: "Pharmacokinetics", confident: true, answer: "The fraction of a dose reaching the circulation.", explanation: "By definition." },
      ],
    });
    assert.deepEqual([questions[0].correctAnswer, questions[0].answerSource, questions[0].explanation], ["Atenolol", "official", null]);
    assert.deepEqual([questions[2].correctAnswer, questions[2].answerSource, questions[2].explanationSource], ["The fraction of a dose reaching the circulation.", "ai_generated", "ai_generated"]);
  });

  it("leaves a question unanswered when the model is unsure or names no real option", async () => {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Biology");
    const set = w.db.addSet(USER_A, subject.id, "No key", [{ correctAnswer: null }, { correctAnswer: null }, { correctAnswer: null, type: "true_false" }]);
    w.model.queue({ questions: [{ id: 1, topic: "Cells", confident: true, answer: null }, { id: 2, topic: "Cells", confident: true, answer: "F" }, { id: 3, topic: "Cells", confident: true, answer: "maybe" }] });

    await analyzeSet(set.id, processingDeps(w, USER_A));
    assert.deepEqual(w.db.questionsOf(set.id).map((q) => [q.topic, q.correctAnswer, q.answerSource]), [["Cells", null, "answer_unavailable"], ["Cells", null, "answer_unavailable"], ["Cells", null, "answer_unavailable"]]);
  });

  it("uses Uncategorized when the model is not confident or the label is not a topic", async () => {
    const { questions } = await analysed({
      questions: [
        { id: 1, topic: "Beta Blockers", confident: false },
        { id: 2, topic: "The exact monitoring test used for warfarin dosing in outpatient anticoagulation clinics", confident: true },
        { id: 3, topic: "general", confident: true },
      ],
    });
    assert.deepEqual(questions.map((q) => q.topic), [UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
    assert.ok(questions.every((q) => q.analyzed));
  });

  it("reuses the student's existing spelling of a topic", () => {
    assert.equal(cleanTopic("cranial  nerves", true, ["Cranial Nerves"]), "Cranial Nerves");
    assert.equal(cleanTopic("Renal Physiology", true, ["Cranial Nerves"]), "Renal Physiology");
  });

  it("ignores entries that are malformed or about questions it was not sent", () => {
    const batch = [pastQuestion({}, USER_A), pastQuestion({}, USER_A)];
    const updates = readAnalysis(JSON.stringify({ questions: [{ id: 9, topic: "Ghost", confident: true }, { id: "1", topic: "Bad id", confident: true }, { id: 2, topic: "Real", confident: true }, { id: 2, topic: "Duplicate", confident: true }, "nonsense"] }), batch, []);
    assert.deepEqual(updates, [{ id: batch[1].id, topic: "Real", difficulty: null }]);
    assert.deepEqual(readAnalysis("I cannot help with that.", batch, []), []);
  });

  it("keeps the paper usable when no AI provider is configured", async () => {
    const w = pastWorld();
    w.configured = false;
    const subject = w.db.addSubject(USER_A, "Pharmacology");
    const set = w.db.addPaper(USER_A, subject.id, "Paper", PAPER);

    const result = await processPastQuestionSet(set.id, processingDeps(w, USER_A));
    assert.equal(result.status, "ready");
    assert.deepEqual(await analyzeSet(set.id, processingDeps(w, USER_A)), { status: "pending", analyzed: 0, remaining: 3, reason: "not_configured" });
    assert.ok(w.db.questionsOf(set.id).every((q) => q.topic === null));
  });

  it("keeps the paper usable when the AI provider fails", async () => {
    const { set, result, questions } = await analysed(new TutorError("PROVIDER_RATE_LIMITED", "429 quota"));
    assert.equal(result.status, "ready");
    assert.equal(set.analysisStatus, "pending");
    assert.ok(questions.every((q) => q.topic === null && !q.analyzed));
    // The official answers read from the paper are untouched.
    assert.equal(questions[0].correctAnswer, "Atenolol");
  });

  it("bounds the number of model calls for a large paper", async () => {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Anatomy");
    const total = PAST.analysisBatchSize * (PAST.analysisMaxCalls + 3);
    const set = w.db.addSet(USER_A, subject.id, "Big", Array.from({ length: total }, () => ({})));
    w.model.fallback = { questions: Array.from({ length: PAST.analysisBatchSize }, (_, index) => ({ id: index + 1, topic: "Anatomy Basics", confident: true })) };

    const result = await analyzeSet(set.id, processingDeps(w, USER_A));
    assert.equal(w.model.calls.length, PAST.analysisMaxCalls);
    assert.deepEqual(result, { status: "partial", analyzed: PAST.analysisBatchSize * PAST.analysisMaxCalls, remaining: PAST.analysisBatchSize * 3, reason: undefined });
  });

  it("counts how often each topic appears, as plain counting", () => {
    const rows = [
      { topic: "Cranial Nerves", year: 2021, setId: "a", type: "multiple_choice" },
      { topic: "cranial nerves", year: 2022, setId: "a", type: "multiple_choice" },
      { topic: "Cranial Nerves", year: 2022, setId: "a", type: "short_answer" },
      { topic: "Cardiovascular System", year: 2021, setId: "a", type: "multiple_choice" },
      { topic: UNCATEGORIZED, year: 2021, setId: "a", type: "multiple_choice" },
      { topic: null, year: 2021, setId: "a", type: "multiple_choice" },
      { topic: "Cranial Nerves", year: 2021, setId: "a", type: "raw" },
      // The same name in another subject is a different topic.
      { topic: "Cranial Nerves", year: 2020, setId: "b", type: "multiple_choice" },
    ];
    assert.deepEqual(topicFrequency(rows, new Map([["a", "Anatomy"], ["b", "Neurology"]])), [
      { topic: "Cranial Nerves", subjectName: "Anatomy", questions: 3, years: [2021, 2022] },
      { topic: "Cardiovascular System", subjectName: "Anatomy", questions: 1, years: [2021] },
      { topic: "Cranial Nerves", subjectName: "Neurology", questions: 1, years: [2020] },
    ]);
  });
});

// ============================================================ selection

describe("choosing questions to practise", () => {
  const Q = (id: string, overrides: Partial<PastQuestion> = {}) => ({ ...pastQuestion(overrides, USER_A), id });
  const POOL = [
    Q("q1", { year: 2021, topic: "Cranial Nerves", difficulty: "easy" }),
    Q("q2", { year: 2021, topic: "Cardiovascular System", difficulty: "hard" }),
    Q("q3", { year: 2022, topic: "cranial nerves", difficulty: "easy" }),
    Q("q4", { year: 2022, topic: null, type: "short_answer" }),
    Q("q5", { year: 2022, topic: "Cardiovascular System", correctAnswer: null }),
    Q("q6", { type: "raw", correctAnswer: null, question: "unreadable" }),
    Q("q7", { year: 2023, topic: "Renal Physiology", type: "true_false", answerSource: "ai_generated" }),
  ];
  const base: SessionCriteria = { kind: "practice", selection: "all", count: null, year: null, topic: null, difficulty: null, only: null };
  const pick = (criteria: Partial<SessionCriteria>, context: { history?: Map<string, "correct" | "partial" | "incorrect">; weakTopics?: string[]; random?: () => number } = {}) =>
    selectQuestions(POOL, { ...base, ...criteria }, { history: new Map(), weakTopics: [], random: () => 0.999, ...context }).map((q) => q.id);
  const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (error) => error instanceof PracticeError && error.code === code);

  it("offers every question that has an answer to mark against, in the paper's order", () => {
    // q5 has no answer and q6 is raw text: neither can be marked.
    assert.deepEqual(pick({}), ["q1", "q2", "q3", "q4", "q7"]);
  });

  it("limits to the count asked for, and draws at random unless 'all' was chosen", () => {
    assert.deepEqual(pick({ count: 2 }), ["q1", "q2"]);
    assert.equal(pick({ selection: "random", count: 3 }).length, 3);
    // A different random source gives a different draw from the same pool.
    assert.notDeepEqual(pick({ selection: "random", count: 5 }, { random: () => 0 }), pick({ selection: "random", count: 5 }));
    // A practice session is simply shorter when fewer are available.
    assert.equal(pick({ count: 30 }).length, 5);
  });

  it("filters by year and by topic, whatever the capitalisation", () => {
    assert.deepEqual(pick({ year: 2022 }), ["q3", "q4"]);
    assert.deepEqual(pick({ topic: "CRANIAL NERVES" }), ["q1", "q3"]);
    assert.deepEqual(pick({ topic: UNCATEGORIZED }), ["q4"]);
    throwsCode(() => pick({ year: 1999 }), "NO_MATCHING_QUESTIONS");
  });

  it("finds unanswered questions and previously missed ones from the student's history", () => {
    const history = new Map<string, "correct" | "partial" | "incorrect">([["q1", "correct"], ["q2", "incorrect"], ["q4", "partial"]]);
    assert.deepEqual(pick({ selection: "unanswered" }, { history }), ["q3", "q7"]);
    assert.deepEqual(pick({ selection: "missed" }, { history }), ["q2", "q4"]);
    throwsCode(() => pick({ selection: "missed" }), "NO_MATCHING_QUESTIONS");
  });

  it("finds questions on the student's weak topics", () => {
    assert.deepEqual(pick({ selection: "weak_topics" }, { weakTopics: ["Cardiovascular system"] }), ["q2"]);
    throwsCode(() => pick({ selection: "weak_topics" }), "NO_MATCHING_QUESTIONS");
  });

  it("filters by difficulty only where an estimate exists, and never pretends one does", () => {
    assert.deepEqual(pick({ difficulty: "easy" }), ["q1", "q3"]);
    const unrated = POOL.map((q) => ({ ...q, difficulty: null }));
    throwsCode(() => selectQuestions(unrated, { ...base, difficulty: "easy" }, { history: new Map(), weakTopics: [], random: Math.random }), "DIFFICULTY_UNAVAILABLE");
  });

  it("puts only objectively markable questions in an exam, and refuses an exam it cannot fill", () => {
    assert.deepEqual(pick({ kind: "exam" }), ["q1", "q2", "q3", "q7"]);
    throwsCode(() => pick({ kind: "exam", selection: "random", count: 10 }), "NOT_ENOUGH_QUESTIONS");
  });

  it("explains why nothing can be practised", () => {
    const context = { history: new Map(), weakTopics: [], random: Math.random };
    throwsCode(() => selectQuestions([], base, context), "NO_PAST_QUESTIONS");
    throwsCode(() => selectQuestions([POOL[5]], base, context), "NO_PAST_QUESTIONS");
    throwsCode(() => selectQuestions([POOL[4]], base, context), "NO_ANSWERS_AVAILABLE");
  });
});

// ============================================================ practice

// A student with an Anatomy collection of six marked questions.
function anatomy(w: PastWorld = pastWorld(), user = USER_A) {
  const subject = w.db.addSubject(user, "Anatomy");
  const set = w.db.addSet(
    user,
    subject.id,
    "Anatomy — 2022",
    [
      { topic: "Cranial Nerves", options: ["Trochlear", "Facial", "Vagus", "Optic"] },
      { topic: "Cranial Nerves", options: ["Olfactory", "Optic", "Abducens", "Vagus"] },
      { topic: "Cardiovascular System", options: ["Aorta", "Vena cava", "Pulmonary vein", "Coronary sinus"] },
      { topic: "Cardiovascular System", type: "true_false", correctAnswer: false },
      { topic: "Respiratory System", options: ["Trachea", "Bronchus", "Alveolus", "Pleura"], answerSource: "ai_generated", explanation: "Gas exchange happens here.", explanationSource: "ai_generated", correctAnswer: "Alveolus" },
      { topic: "Respiratory System", type: "short_answer", correctAnswer: "The diaphragm contracts and flattens." },
    ],
    2022,
  );
  return { w, subject, set, questions: w.db.questionsOf(set.id) };
}

describe("past-question practice", () => {
  it("makes a practice session that is an ordinary quiz, taken with the ordinary quiz service", async () => {
    const { w, subject, set } = anatomy();

    const { quiz, attempt, delivered } = await createPastSession({ kind: "practice", setIds: [set.id], selection: "all", count: "all" }, pastDeps(w, USER_A));

    assert.equal(attempt, null);
    assert.equal(delivered, 6);
    assert.deepEqual([quiz.mode, quiz.title, quiz.subjectId, quiz.questionCount], ["past_practice", "Practice: Anatomy — 2022", subject.id, 6]);
    assert.equal(w.db.quizzes.quizzes[0].userId, USER_A);
    assert.equal(w.db.sessionSets.get(quiz.id), set.id);

    // From here on it is the Phase 6 quiz flow, unchanged.
    const started = await startAttempt(quiz.id, quizDeps(w, USER_A));
    assert.equal(started.questions.length, 6);
    assert.ok(started.questions.every((question) => !("correctAnswer" in question)));

    const right = await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[0].id, answer: 0 }, quizDeps(w, USER_A));
    const wrong = await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[4].id, answer: 0 }, quizDeps(w, USER_A));
    assert.deepEqual([right.result, right.answerSource, right.topic], ["correct", "official", "Cranial Nerves"]);
    // An answer Ari worked out is labelled as such in the feedback.
    assert.deepEqual([wrong.result, wrong.answerSource, wrong.correctAnswer], ["incorrect", "ai_generated", "Alveolus"]);

    const summary = await completeAttempt(started.attempt.id, quizDeps(w, USER_A));
    assert.equal(summary.attempt.score, 1);
    assert.equal(summary.attempt.totalQuestions, 6);
  });

  it("then offers the questions missed, and the ones not yet tried", async () => {
    const { w, set, questions } = anatomy();
    const { quiz } = await createPastSession({ kind: "practice", setIds: [set.id], selection: "all", count: "all" }, pastDeps(w, USER_A));
    const started = await startAttempt(quiz.id, quizDeps(w, USER_A));
    await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[0].id, answer: 0 }, quizDeps(w, USER_A));
    await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[1].id, answer: 1 }, quizDeps(w, USER_A));
    await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[3].id, answer: true }, quizDeps(w, USER_A));

    const mistakes = await createPastSession({ kind: "practice", selection: "missed", count: "all" }, pastDeps(w, USER_A));
    assert.equal(mistakes.quiz.title, "My mistakes: Anatomy — 2022");
    const copies = (await w.db.as(USER_A).getQuestions(mistakes.quiz.id)).map((q) => q.pastQuestionId);
    assert.deepEqual(copies.sort(), [questions[1].id, questions[3].id].sort());

    const untried = await createPastSession({ kind: "practice", selection: "unanswered", count: 5 }, pastDeps(w, USER_A));
    assert.equal(untried.delivered, 3);
    assert.equal(untried.requested, 5);
  });

  it("starts practice on the student's weak topics without their having to find the questions", async () => {
    const { w } = anatomy();
    w.weakTopics = ["Cardiovascular System"];
    const { quiz, delivered } = await createPastSession({ kind: "practice", selection: "weak_topics", count: 10 }, pastDeps(w, USER_A));
    assert.equal(delivered, 2);
    assert.equal(quiz.title, "Weak topics: Anatomy — 2022");
  });

  it("can draw from several collections, and from one subject", async () => {
    const { w, subject, set } = anatomy();
    const other = w.db.addSubject(USER_A, "Physiology");
    const second = w.db.addSet(USER_A, other.id, "Physiology 2021", [{}, {}], 2021);
    w.db.addSet(USER_A, subject.id, "Not ready", [{}]).status = "processing";

    const mixed = await createPastSession({ kind: "practice", setIds: [set.id, second.id], selection: "all", count: "all" }, pastDeps(w, USER_A));
    assert.deepEqual([mixed.delivered, mixed.quiz.title, mixed.quiz.subjectId], [8, "Practice: Mixed past questions", null]);
    assert.equal(w.db.sessionSets.get(mixed.quiz.id), null);

    const bySubject = await createPastSession({ kind: "practice", subjectId: subject.id, year: 2022, selection: "all", count: "all" }, pastDeps(w, USER_A));
    assert.deepEqual([bySubject.delivered, bySubject.quiz.subjectId], [6, subject.id]);
  });

  it("requires authentication and does nothing without it", async () => {
    const { w, set } = anatomy();
    await rejectsWith(createPastSession({ kind: "practice", setIds: [set.id], count: 5 }, pastDeps(w, null)), "UNAUTHENTICATED");
    assert.equal(w.db.quizzes.quizzes.length, 0);
  });

  it("cannot be started from another student's collection or subject", async () => {
    const { w, set, subject } = anatomy();
    w.db.addSubject(USER_B, "Anatomy");

    await rejectsWith(createPastSession({ kind: "practice", setIds: [set.id], count: 5 }, pastDeps(w, USER_B)), "NOT_FOUND");
    await rejectsWith(createPastSession({ kind: "practice", subjectId: subject.id, count: 5 }, pastDeps(w, USER_B)), "SUBJECT_NOT_FOUND");
    await rejectsWith(createPastSession({ kind: "practice", count: 5 }, pastDeps(w, USER_B)), "NO_PAST_QUESTIONS");
    assert.equal(w.db.quizzes.quizzes.length, 0);

    // With a collection of their own, B still cannot reach into A's.
    const own = w.db.addSet(USER_B, w.db.quizzes.subjects.find((s) => s.userId === USER_B)!.id, "B's paper", [{}]);
    await rejectsWith(createPastSession({ kind: "practice", setIds: [set.id, own.id], count: 5 }, pastDeps(w, USER_B)), "NOT_FOUND");
  });

  it("rejects requests that are not well formed", async () => {
    const { w, set } = anatomy();
    const deps = pastDeps(w, USER_A);
    await rejectsWith(createPastSession({ kind: "practice", count: 7 }, deps), "INVALID_REQUEST");
    await rejectsWith(createPastSession({ kind: "practice", count: 5, selection: "everything" }, deps), "INVALID_REQUEST");
    await rejectsWith(createPastSession({ kind: "practice", count: 5, difficulty: "brutal" }, deps), "INVALID_REQUEST");
    await rejectsWith(createPastSession({ kind: "practice", count: 5, year: "soon" }, deps), "INVALID_REQUEST");
    await rejectsWith(createPastSession({ kind: "practice", count: 5, setIds: ["nope"] }, deps), "NOT_FOUND");
    await rejectsWith(createPastSession({ kind: "practice", count: 5, setIds: [set.id], difficulty: "hard" }, deps), "DIFFICULTY_UNAVAILABLE");
  });

  it("reports a database failure without leaking its details", async () => {
    const { w, set } = anatomy();
    w.db.quizzes.failWrites = true;
    const result = await toResult("past practice", () => createPastSession({ kind: "practice", setIds: [set.id], count: 5 }, pastDeps(w, USER_A)));
    assert.deepEqual(result, { ok: false, error: PRACTICE_ERRORS.DATABASE_ERROR, code: "DATABASE_ERROR" });
  });
});

// ================================================================ exams

// An exam on four Anatomy questions: three multiple choice and one
// true/false, all with the paper's own answers. (The question whose answer
// is Ari's is taken out here; it has tests of its own.)
async function exam(input: object = {}, w?: PastWorld) {
  const world = anatomy(w);
  world.w.db.questions = world.w.db.questions.filter((question) => question.answerSource !== "ai_generated");
  const { quiz, attempt } = await createPastSession({ kind: "exam", setIds: [world.set.id], count: "all", ...input }, pastDeps(world.w, USER_A));
  const copies = await world.w.db.as(USER_A).getQuestions(quiz.id);
  return { ...world, quiz, attempt: attempt!, copies };
}

// Every question answered correctly.
function perfect(copies: SessionQuestion[]) {
  return Object.fromEntries(copies.map((q) => [q.id, q.type === "true_false" ? q.correctAnswer : q.options.indexOf(q.correctAnswer as string)]));
}

describe("exam mode: setting up", () => {
  it("creates an exam with its clock already running", async () => {
    const { quiz, attempt, copies, w } = await exam({ timeLimitMinutes: 30 });

    assert.deepEqual([quiz.mode, quiz.title, quiz.questionCount], ["exam", "Exam: Anatomy — 2022", 4]);
    assert.deepEqual([attempt.timeLimitSeconds, attempt.totalQuestions, attempt.completedAt, attempt.score], [1800, 4, null, null]);
    // The written question is left out: an exam is marked without judgement.
    assert.ok(copies.every((q) => q.type !== "short_answer"));
    assert.equal(secondsRemaining(attempt, w.db.now()), 1800);
    w.db.advance(600);
    assert.equal(secondsRemaining(attempt, w.db.now()), 1200);
    w.db.advance(5000);
    assert.equal(secondsRemaining(attempt, w.db.now()), 0);
  });

  it("gives the browser the questions with nothing that reveals an answer", async () => {
    const { copies } = await exam();
    for (const question of copies.map(toExamQuestion)) {
      assert.deepEqual(Object.keys(question).sort(), ["id", "options", "position", "question", "type"]);
    }
  });

  it("allows no timer, the preset times and a sensible custom time, and nothing else", async () => {
    assert.equal((await exam()).attempt.timeLimitSeconds, null);
    assert.equal((await exam({ timeLimitMinutes: null })).attempt.timeLimitSeconds, null);
    for (const minutes of [...PAST.examDurations, PAST.minCustomMinutes, 90, PAST.maxCustomMinutes]) {
      assert.equal((await exam({ timeLimitMinutes: minutes })).attempt.timeLimitSeconds, minutes * 60);
    }
    for (const minutes of [0, 1, -30, 2.5, PAST.maxCustomMinutes + 1, 100000, "30", Number.NaN, Infinity]) {
      const world = anatomy();
      await rejectsWith(createPastSession({ kind: "exam", setIds: [world.set.id], count: "all", timeLimitMinutes: minutes }, pastDeps(world.w, USER_A)), "INVALID_TIME_LIMIT");
      assert.equal(world.w.db.quizzes.quizzes.length, 0, `${minutes} minutes created an exam`);
    }
  });

  it("refuses an exam larger than the questions available, and offers the sizes configured", async () => {
    const { w, set } = anatomy();
    await rejectsWith(createPastSession({ kind: "exam", setIds: [set.id], count: 10 }, pastDeps(w, USER_A)), "NOT_ENOUGH_QUESTIONS");
    await rejectsWith(createPastSession({ kind: "exam", setIds: [set.id], count: 5 }, pastDeps(w, USER_A)), "INVALID_REQUEST");
    assert.equal(w.db.quizzes.quizzes.length, 0);
    assert.deepEqual(PAST.examSizes, [10, 20, 30, 50]);
  });

  it("cannot be taken through the quiz flow, which would mark each answer as it is given", async () => {
    const { w, quiz, attempt, copies } = await exam();
    await rejectsWith(startAttempt(quiz.id, quizDeps(w, USER_A)), "NOT_FOUND");
    await rejectsWith(answerQuestion({ attemptId: attempt.id, questionId: copies[0].id, answer: 0 }, quizDeps(w, USER_A)), "DATABASE_ERROR");
    assert.equal(w.db.quizzes.answers.length, 0);
  });
});

describe("exam mode: submitting", () => {
  it("marks the exam on the server and stores the attempt", async () => {
    const { w, attempt, copies } = await exam({ timeLimitMinutes: 30 });
    w.db.advance(754);
    const answers = { ...perfect(copies), [copies[1].id]: 3 };

    const review = await submitExam({ attemptId: attempt.id, answers, flagged: [copies[2].id] }, pastDeps(w, USER_A));

    assert.deepEqual(review.totals, {
      total: 4, answered: 4, unanswered: 0, correct: 3, incorrect: 1, percent: 75, accuracy: 0.75,
      timeUsedSeconds: 754, timeLimitSeconds: 1800, timeRemainingSeconds: 1046, late: false,
    });
    const stored = w.db.quizzes.attempts[0];
    assert.deepEqual([stored.userId, stored.score, stored.totalQuestions, Boolean(stored.completedAt)], [USER_A, 3, 4, true]);
    assert.equal(w.db.quizzes.answers.length, 4);
    assert.ok(w.db.quizzes.answers.every((answer) => answer.userId === USER_A && answer.attemptId === attempt.id));
  });

  it("counts unanswered questions as unanswered: no marks, and no answer stored", async () => {
    const { w, attempt, copies } = await exam();
    const review = await submitExam({ attemptId: attempt.id, answers: { [copies[0].id]: 0 } }, pastDeps(w, USER_A));

    assert.deepEqual([review.totals.answered, review.totals.unanswered, review.totals.correct, review.totals.incorrect, review.totals.percent, review.totals.accuracy], [1, 3, 1, 0, 25, 1]);
    assert.deepEqual(review.questions.map((q) => q.result), ["correct", "unanswered", "unanswered", "unanswered"]);
    assert.deepEqual(review.questions.map((q) => q.answer), ["Trochlear", null, null, null]);
    assert.equal(w.db.quizzes.answers.length, 1);
    assert.equal(review.retryable, 3);

    const blank = await exam();
    const empty = await submitExam({ attemptId: blank.attempt.id }, pastDeps(blank.w, USER_A));
    assert.deepEqual([empty.totals.answered, empty.totals.percent, empty.totals.accuracy], [0, 0, null]);
  });

  it("remembers which questions were marked for review", async () => {
    const { w, attempt, copies } = await exam();
    const review = await submitExam({ attemptId: attempt.id, answers: perfect(copies), flagged: [copies[1].id, copies[1].id, "not-a-question", 42] }, pastDeps(w, USER_A));
    assert.deepEqual(review.questions.map((q) => q.flagged), [false, true, false, false]);
    assert.deepEqual((w.db.quizzes.attempts[0] as unknown as ExamAttempt).state.flagged, [copies[1].id]);
  });

  it("ignores a score, results or correct answers sent by the client", async () => {
    const { w, attempt, copies } = await exam();
    const forged = {
      attemptId: attempt.id,
      // Every answer is wrong...
      answers: Object.fromEntries(copies.map((q) => [q.id, q.type === "true_false" ? true : 3])),
      // ...and the request claims otherwise in every way it can.
      score: 4, percent: 100, correct: 4, totalQuestions: 1, completedAt: "2020-01-01T00:00:00Z", userId: USER_B,
      results: Object.fromEntries(copies.map((q) => [q.id, "correct"])),
      correctAnswers: Object.fromEntries(copies.map((q) => [q.id, 3])),
      topics: { [copies[0].id]: "Forged Topic" },
    };

    const review = await submitExam(forged, pastDeps(w, USER_A));

    assert.deepEqual([review.totals.correct, review.totals.percent, review.totals.total], [0, 0, 4]);
    assert.equal(w.db.quizzes.attempts[0].score, 0);
    assert.ok(w.db.quizzes.answers.every((answer) => answer.result === "incorrect" && answer.userId === USER_A));
    assert.ok(review.topics.every((row) => row.topic !== "Forged Topic"));
  });

  it("drops answers that are not a real choice for the question", async () => {
    const { copies } = await exam();
    const [mcq, , , trueFalse] = copies;
    const state = cleanExamState(
      { answers: { [mcq.id]: 9, [copies[1].id]: "Olfactory", [copies[2].id]: 1.5, [trueFalse.id]: "true", "someone-elses-question": 0 }, flagged: "all" },
      copies,
    );
    assert.deepEqual(state, { answers: {}, flagged: [] });
    assert.deepEqual(cleanExamState({ answers: { [mcq.id]: 2, [trueFalse.id]: false } }, copies), { answers: { [mcq.id]: 2, [trueFalse.id]: false }, flagged: [] });
    assert.deepEqual(cleanExamState(null, copies), { answers: {}, flagged: [] });
    assert.deepEqual(cleanExamState({ answers: [0, 1, 2] }, copies), { answers: {}, flagged: [] });
  });

  it("returns the first result unchanged when submitted twice", async () => {
    const { w, attempt, copies } = await exam();
    const first = await submitExam({ attemptId: attempt.id, answers: { [copies[0].id]: 3 } }, pastDeps(w, USER_A));
    w.db.advance(900);
    const second = await submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A));

    assert.equal(first.totals.correct, 0);
    assert.deepEqual(second.totals, first.totals);
    assert.equal(w.db.quizzes.answers.length, 1);
    assert.equal(second.attempt.completedAt, first.attempt.completedAt);
  });

  it("cannot be submitted, saved or read by anyone but its owner", async () => {
    const { w, attempt, copies } = await exam();

    await rejectsWith(submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_B)), "EXAM_NOT_FOUND");
    await rejectsWith(saveExamProgress({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_B)), "EXAM_NOT_FOUND");
    await rejectsWith(getExamReview(attempt.id, pastDeps(w, USER_B)), "EXAM_NOT_FOUND");
    await rejectsWith(submitExam({ attemptId: attempt.id }, pastDeps(w, null)), "UNAUTHENTICATED");
    await rejectsWith(submitExam({ attemptId: "not-an-id" }, pastDeps(w, USER_A)), "EXAM_NOT_FOUND");

    // A's exam is exactly as it was: still open, with nothing marked.
    assert.equal(w.db.quizzes.attempts[0].completedAt, null);
    assert.equal(w.db.quizzes.answers.length, 0);

    // And B's attempt at retrying A's exam finds nothing either.
    await submitExam({ attemptId: attempt.id, answers: {} }, pastDeps(w, USER_A));
    w.db.addSet(USER_B, w.db.addSubject(USER_B, "Anatomy").id, "B's", [{}]);
    await rejectsWith(createPastSession({ kind: "practice", retryAttemptId: attempt.id }, pastDeps(w, USER_B)), "NOT_FOUND");
  });

  it("shows nothing about the answers until the exam is submitted", async () => {
    const { w, attempt, copies } = await exam();
    await rejectsWith(getExamReview(attempt.id, pastDeps(w, USER_A)), "EXAM_NOT_FOUND");
    const saved = await saveExamProgress({ attemptId: attempt.id, answers: { [copies[0].id]: 1 } }, pastDeps(w, USER_A));
    assert.deepEqual(saved, { saved: true });
    assert.equal(w.db.quizzes.answers.length, 0);
  });

  it("reports a failed submission as one, keeping the exam open", async () => {
    const { w, attempt, copies } = await exam();
    w.db.quizzes.failWrites = true;
    const result = await toResult("exam submission", () => submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A)));
    assert.deepEqual(result, { ok: false, error: PRACTICE_ERRORS.EXAM_SUBMIT_FAILED, code: "EXAM_SUBMIT_FAILED" });
    assert.equal(w.db.quizzes.attempts[0].completedAt, null);
  });
});

describe("exam mode: the timer", () => {
  it("accepts a submission within the grace period after time is up", async () => {
    const { w, attempt, copies } = await exam({ timeLimitMinutes: 15 });
    w.db.advance(15 * 60 + PAST.graceSeconds);
    const review = await submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A));
    assert.deepEqual([review.totals.correct, review.totals.late, review.totals.timeUsedSeconds, review.totals.timeRemainingSeconds], [4, false, 900, 0]);
  });

  it("marks a late submission from the answers saved in time, not the ones sent late", async () => {
    const { w, attempt, copies } = await exam({ timeLimitMinutes: 15 });
    w.db.advance(600);
    await saveExamProgress({ attemptId: attempt.id, answers: { [copies[0].id]: 0 }, flagged: [copies[3].id] }, pastDeps(w, USER_A));

    // Long after the end, a submission arrives with every answer filled in.
    w.db.advance(3600);
    assert.deepEqual(await saveExamProgress({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A)), { saved: false });
    const review = await submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A));

    assert.deepEqual([review.totals.answered, review.totals.correct, review.totals.late], [1, 1, true]);
    // Time used is never more than the time allowed.
    assert.deepEqual([review.totals.timeUsedSeconds, review.totals.timeRemainingSeconds], [900, 0]);
    assert.deepEqual(review.questions.map((q) => q.flagged), [false, false, false, true]);
  });

  it("has no deadline when there is no timer", async () => {
    const { w, attempt, copies } = await exam();
    w.db.advance(3 * 24 * 3600);
    const review = await submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A));
    assert.deepEqual([review.totals.correct, review.totals.late, review.totals.timeLimitSeconds, review.totals.timeRemainingSeconds, review.totals.timeUsedSeconds], [4, false, null, null, 259200]);
    assert.equal(secondsRemaining(attempt, w.db.now()), null);
  });

  it("refuses to save progress once the exam has been submitted", async () => {
    const { w, attempt, copies } = await exam();
    await submitExam({ attemptId: attempt.id, answers: {} }, pastDeps(w, USER_A));
    assert.deepEqual(await saveExamProgress({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A)), { saved: false });
    assert.equal(w.db.quizzes.attempts[0].score, 0);
  });
});

describe("exam mode: the review", () => {
  it("breaks the result down by topic and question type, and by difficulty only where rated", async () => {
    const { w, attempt, copies } = await exam();
    const answers = { ...perfect(copies), [copies[1].id]: 2, [copies[3].id]: true };
    const review = await submitExam({ attemptId: attempt.id, answers }, pastDeps(w, USER_A));

    assert.deepEqual(review.topics, [
      { topic: "Cardiovascular System", correct: 1, total: 2, accuracy: 0.5 },
      { topic: "Cranial Nerves", correct: 1, total: 2, accuracy: 0.5 },
    ]);
    assert.deepEqual(review.types, [
      { type: "multiple_choice", correct: 2, total: 3, accuracy: 2 / 3 },
      { type: "true_false", correct: 0, total: 1, accuracy: 0 },
    ]);
    // None of these questions carries a difficulty estimate, so none is shown.
    assert.deepEqual(review.difficulties, []);
  });

  it("counts only the questions that carry a difficulty estimate", async () => {
    const world = anatomy();
    world.questions[0].difficulty = "hard";
    world.questions[2].difficulty = "hard";
    const { quiz, attempt } = await createPastSession({ kind: "exam", setIds: [world.set.id], count: "all" }, pastDeps(world.w, USER_A));
    const copies = await world.w.db.as(USER_A).getQuestions(quiz.id);
    assert.equal(copies.length, 5);

    const review = await submitExam({ attemptId: attempt!.id, answers: { [copies[0].id]: 0, [copies[1].id]: 0 } }, pastDeps(world.w, USER_A));
    assert.deepEqual(review.difficulties, [{ difficulty: "hard", correct: 1, total: 2, accuracy: 0.5 }]);
    assert.equal(review.totals.correct, 2);
  });

  it("shows each question with the student's answer, the correct one and where that came from", async () => {
    const w = pastWorld();
    const subject = w.db.addSubject(USER_A, "Anatomy");
    const set = w.db.addSet(USER_A, subject.id, "Mixed sources", [
      { number: "7", options: ["Right", "Wrong"], explanation: "Because the key says so.", explanationSource: "official", topic: "Thorax" },
      { number: "8", options: ["Wrong", "Right"], correctAnswer: "Right", answerSource: "ai_generated", explanation: "Ari's reasoning.", explanationSource: "ai_generated" },
    ]);
    const { attempt, quiz } = await createPastSession({ kind: "exam", setIds: [set.id], count: "all" }, pastDeps(w, USER_A));
    const copies = await w.db.as(USER_A).getQuestions(quiz.id);

    const review = await submitExam({ attemptId: attempt!.id, answers: { [copies[0].id]: 1 } }, pastDeps(w, USER_A));

    assert.deepEqual(
      review.questions.map((q) => [q.number, q.answer, q.result, q.correctAnswer, q.answerSource, q.explanationSource, q.topic]),
      [["7", "Wrong", "incorrect", "Right", "official", "official", "Thorax"], ["8", null, "unanswered", "Right", "ai_generated", "ai_generated", UNCATEGORIZED]],
    );
    assert.ok(review.questions[0].answerId);
    assert.equal(review.questions[1].answerId, null);
    // The same review is what the owner sees when they open the attempt again.
    assert.deepEqual((await getExamReview(attempt!.id, pastDeps(w, USER_A))).totals, review.totals);
  });

  it("starts a retry of exactly the questions missed or left out", async () => {
    const { w, attempt, copies } = await exam();
    await submitExam({ attemptId: attempt.id, answers: { [copies[0].id]: 0, [copies[1].id]: 1 } }, pastDeps(w, USER_A));

    const retry = await createPastSession({ kind: "practice", retryAttemptId: attempt.id }, pastDeps(w, USER_A));
    assert.deepEqual([retry.quiz.mode, retry.quiz.title, retry.delivered], ["past_practice", "Retry: Anatomy — 2022", 3]);
    const retried = (await w.db.as(USER_A).getQuestions(retry.quiz.id)).map((q) => q.pastQuestionId).sort();
    assert.deepEqual(retried, copies.slice(1).map((q) => q.pastQuestionId).sort());

    // An exam still in progress has no mistakes to retry yet.
    const open = await exam({}, w);
    await rejectsWith(createPastSession({ kind: "practice", retryAttemptId: open.attempt.id }, pastDeps(w, USER_A)), "NOT_FOUND");
  });

  it("keeps a finished exam's result after its collection is deleted", async () => {
    const { w, attempt, copies, set } = await exam();
    await submitExam({ attemptId: attempt.id, answers: perfect(copies) }, pastDeps(w, USER_A));
    w.db.sets = w.db.sets.filter((item) => item.id !== set.id);
    w.db.questions = [];

    const review = await getExamReview(attempt.id, pastDeps(w, USER_A));
    assert.deepEqual([review.totals.correct, review.totals.total, review.questions.length], [4, 4, 4]);
  });
});

describe("Ask Ari to explain a past question", () => {
  it("tells the tutor the question, both answers, the topic and whose answer it is", async () => {
    const { w, attempt, copies } = await exam();
    const review = await submitExam({ attemptId: attempt.id, answers: { [copies[0].id]: 2 } }, pastDeps(w, USER_A));
    const answer = w.db.quizzes.answers[0];
    const message = buildExplainMessage(copies[0], toFeedback(copies[0], answer));

    assert.equal(review.questions[0].answerId, answer.id);
    assert.match(message, /^I got this quiz question wrong/);
    assert.match(message, /Options: A\) Trochlear {2}B\) Facial {2}C\) Vagus {2}D\) Optic/);
    assert.match(message, /My answer: Vagus/);
    assert.match(message, /Correct answer \(from my paper's answer key\): Trochlear/);
    assert.match(message, /Topic: Cranial Nerves/);
    assert.match(message, /Source: Anatomy — 2022/);
  });

  it("asks the tutor to check an answer that was Ari's own, rather than repeat it", async () => {
    const { w, set } = anatomy();
    const { quiz } = await createPastSession({ kind: "practice", setIds: [set.id], topic: "Respiratory System", selection: "all", count: "all" }, pastDeps(w, USER_A));
    const started = await startAttempt(quiz.id, quizDeps(w, USER_A));
    await answerQuestion({ attemptId: started.attempt.id, questionId: started.questions[0].id, answer: 0 }, quizDeps(w, USER_A));
    const copy = (await w.db.as(USER_A).getQuestions(quiz.id))[0];

    const message = buildExplainMessage(copy, toFeedback(copy, w.db.quizzes.answers[0]));
    assert.match(message, /Suggested answer \(worked out by Ari; my paper has no answer key, so please check it\): Alveolus/);
    assert.doesNotMatch(message, /Correct answer/);
  });
});
