// Regression tests for "Ari couldn't find any study material" being shown
// for a material that is processed and marked Ready for Ari.
//
// The cause was a search that returned nothing for a reason other than
// "nothing uploaded": the material's passages were stored but tagged with a
// different embedding model than the one in use, and the search only looks
// at passages made by the model in use. Every empty search was reported as
// missing material.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRACTICE } from "@/lib/ai/practice/config";
import { PRACTICE_ERRORS, PracticeError, toResult } from "@/lib/ai/practice/errors";
import { generateDeck } from "@/lib/ai/practice/flashcard-service";
import { generateQuiz } from "@/lib/ai/practice/quiz-service";
import { TutorError } from "@/lib/ai/tutor/errors";
import { card, mcq, practiceDeps, practiceWorld, trueFalse, type PracticeWorld } from "./practice-fakes";
import { chunk } from "./tutor-fakes";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PracticeError, `expected a PracticeError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const SLIDES = [
  "Blepharitis is a chronic inflammation of the eyelid margin, commonly associated with staphylococcal infection or seborrhoea.",
  "A chalazion is a chronic lipogranulomatous inflammation of a meibomian gland; it is painless and treated with warm compresses.",
  "A hordeolum (stye) is an acute, painful staphylococcal infection of a gland of Zeis or of a meibomian gland.",
  "Ptosis is drooping of the upper eyelid and may be congenital, neurogenic, myogenic, aponeurotic or mechanical.",
  "Entropion is an inward turning of the eyelid margin, so that the lashes rub against the cornea and conjunctiva.",
  "Ectropion is an outward turning of the eyelid margin, which exposes the conjunctiva and causes epiphora.",
];

// A student with one ready PowerPoint whose slides are in the knowledge base.
function eyelids(w: PracticeWorld = practiceWorld(), user = USER_A) {
  const subject = w.db.addSubject(user, "Ophthalmology");
  const material = w.db.addMaterial(user, subject.id, "3 Eyelid disorders Oghre");
  w.knowledge.add(
    user,
    ...SLIDES.map((content, index) =>
      chunk({ content, chunkIndex: index, slideNumber: index * 6 + 2, materialId: material.id, materialTitle: material.title, subjectId: subject.id, subjectName: "Ophthalmology" }),
    ),
  );
  return { w, subject, material };
}

const QUESTIONS = [
  mcq("Which eyelid condition is a chronic lipogranulomatous inflammation of a meibomian gland?", 2, { options: ["Chalazion", "Hordeolum", "Ptosis", "Entropion"], topic: "Chalazion" }),
  trueFalse("A hordeolum is typically painless.", false, 3, { topic: "Hordeolum" }),
  mcq("What is the term for drooping of the upper eyelid?", 4, { options: ["Ptosis", "Ectropion", "Blepharitis", "Chalazion"], topic: "Ptosis" }),
  trueFalse("In entropion the eyelid margin turns inward.", true, 5, { topic: "Entropion" }),
  mcq("Which condition exposes the conjunctiva and causes epiphora?", 6, { options: ["Ectropion", "Entropion", "Hordeolum", "Blepharitis"], topic: "Ectropion" }),
];
const CARDS = Array.from({ length: 10 }, (_, index) => card(`What is eyelid fact number ${index} alpha${index} beta${index}?`, `It is answer number ${index}.`, (index % 6) + 1));

describe("a ready material with indexed content", () => {
  it("is found by flashcards, by its material and by its subject", async () => {
    const { w, material, subject } = eyelids();
    w.model.queue({ cards: CARDS }, { cards: CARDS });

    const byMaterial = await generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A));
    const bySubject = await generateDeck({ subjectId: subject.id, count: 10 }, practiceDeps(w, USER_A));

    assert.equal(byMaterial.delivered, 10);
    assert.equal(bySubject.delivered, 10);
    assert.equal(byMaterial.deck.materialId, material.id);
    // The model was shown the material's own slides.
    assert.ok(w.model.prompt(0).includes("chronic lipogranulomatous inflammation"));
    assert.ok(w.model.prompt(0).includes(`"3 Eyelid disorders Oghre" — subject: Ophthalmology — slide 2`));
    assert.equal(w.db.cards.length, 20);
  });

  it("is found by a quiz", async () => {
    const { w, material } = eyelids();
    w.model.queue({ questions: QUESTIONS });

    const { quiz } = await generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A));

    assert.equal(quiz.questionCount, 5);
    assert.ok(w.model.prompt(0).includes("Ptosis is drooping of the upper eyelid"));
    assert.equal(w.db.questions[0].source?.title, "3 Eyelid disorders Oghre");
  });

  it("is found by quick practice, with no subject or material chosen at all", async () => {
    const { w } = eyelids();
    w.model.queue({ questions: QUESTIONS });

    const { quiz } = await generateQuiz({ mode: "practice" }, practiceDeps(w, USER_A));

    assert.equal(quiz.mode, "practice");
    assert.equal(quiz.questionCount, PRACTICE.practiceSize);
    assert.ok(w.model.prompt(0).includes("Entropion is an inward turning"));
  });
});

describe("a ready material the similarity search cannot reach", () => {
  // The real bug: passages are stored, but tagged with another embedding
  // model, so the search (which only looks at the model in use) is empty.
  function mislabelled() {
    const world = eyelids();
    world.w.knowledge.mislabelled.add(world.material.id);
    return world;
  }

  it("is still used for flashcards, by reading its passages in order", async () => {
    const { w, material } = mislabelled();
    w.model.queue({ cards: CARDS });

    const { deck, delivered } = await generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A));

    assert.equal(delivered, 10);
    assert.equal(deck.materialId, material.id);
    assert.equal(w.knowledge.browses, 1);
    // The cards were written from the real slides, in reading order.
    const prompt = w.model.prompt(0);
    assert.ok(prompt.indexOf("Blepharitis is a chronic") < prompt.indexOf("Ectropion is an outward"));
    assert.equal(w.db.cards[0].source?.slide, 2);
  });

  it("is still used for a quiz and for quick practice", async () => {
    const { w, material } = mislabelled();
    w.model.queue({ questions: QUESTIONS }, { questions: QUESTIONS });

    const quiz = await generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A));
    const practice = await generateQuiz({ mode: "practice" }, practiceDeps(w, USER_A));

    assert.equal(quiz.quiz.questionCount, 5);
    assert.equal(practice.quiz.questionCount, 5);
    assert.ok(w.model.prompt(1).includes("A hordeolum (stye)"));
  });

  it("asks for a reprocess when a topic is given, since a topic cannot be matched without comparable vectors", async () => {
    const { w, material } = mislabelled();

    const result = await toResult("deck generation", () => generateDeck({ materialId: material.id, count: 10, topic: "ptosis" }, practiceDeps(w, USER_A)));

    assert.deepEqual(result, { ok: false, error: PRACTICE_ERRORS.MATERIAL_NEEDS_REPROCESS, code: "MATERIAL_NEEDS_REPROCESS" });
    assert.match(PRACTICE_ERRORS.MATERIAL_NEEDS_REPROCESS, /Reprocess/);
    // Nothing was read out of order, generated or saved.
    assert.equal(w.knowledge.browses + w.model.calls.length + w.db.decks.length, 0);
  });

  it("does not read passages in order when the ordinary search works", async () => {
    const { w, material } = eyelids();
    w.model.queue({ questions: QUESTIONS });
    await generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A));
    assert.equal(w.knowledge.browses, 0);
  });
});

describe("the three ways there can be nothing to work from", () => {
  it("says there is no ready material when nothing is ready", async () => {
    const w = practiceWorld();
    const subject = w.db.addSubject(USER_A, "Ophthalmology");
    w.db.addMaterial(USER_A, subject.id, "Still being read", "processing");

    const runs: (() => Promise<unknown>)[] = [() => generateDeck({ subjectId: subject.id, count: 10 }, practiceDeps(w, USER_A)), () => generateQuiz({ subjectId: subject.id, count: 5 }, practiceDeps(w, USER_A)), () => generateQuiz({ mode: "practice" }, practiceDeps(w, USER_A))];
    for (const run of runs) {
      assert.deepEqual(await toResult("generation", run), { ok: false, error: PRACTICE_ERRORS.NO_MATERIAL, code: "NO_MATERIAL" });
    }
    assert.match(PRACTICE_ERRORS.NO_MATERIAL, /^No ready study material is available/);
    assert.equal(w.model.calls.length, 0);
  });

  it("says to reprocess when a material is marked ready but nothing is indexed for it", async () => {
    const w = practiceWorld();
    const subject = w.db.addSubject(USER_A, "Ophthalmology");
    const material = w.db.addMaterial(USER_A, subject.id, "Ready with an empty index");

    const runs: (() => Promise<unknown>)[] = [() => generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A)), () => generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A)), () => generateQuiz({ mode: "practice", subjectId: subject.id }, practiceDeps(w, USER_A))];
    for (const run of runs) {
      assert.deepEqual(await toResult("generation", run), { ok: false, error: PRACTICE_ERRORS.MATERIAL_NOT_INDEXED, code: "MATERIAL_NOT_INDEXED" });
    }
    assert.match(PRACTICE_ERRORS.MATERIAL_NOT_INDEXED, /marked ready, but no indexed content was found.*Reprocess/);
    assert.notEqual(PRACTICE_ERRORS.MATERIAL_NOT_INDEXED, PRACTICE_ERRORS.NO_MATERIAL);
    assert.equal(w.model.calls.length, 0);
  });

  it("does not call an AI failure missing material", async () => {
    const failures: [TutorError | string, string][] = [
      // The model answered, but not with anything usable.
      [new TutorError("PROVIDER_ERROR", "gemini 500"), "GENERATION_FAILED"],
      ["this is not JSON at all", "GENERATION_FAILED"],
      // The model could not be reached in time.
      [new TutorError("TIMEOUT", "gemini timed out"), "AI_UNAVAILABLE"],
    ];
    for (const [failure, code] of failures) {
      const { w, material } = eyelids();
      w.model.fallback = "still not JSON";
      w.model.queue(failure);

      const deck = await toResult("deck generation", () => generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A)));
      assert.equal(!deck.ok && deck.code, code);
      assert.doesNotMatch(!deck.ok ? deck.error : "", /Upload|No ready study material|couldn't find any study material/);
      if (code === "GENERATION_FAILED") assert.match(!deck.ok ? deck.error : "", /^The study material was found, but Ari couldn't generate this right now/);
      // The material was found and given to the model before it failed.
      assert.ok(w.model.prompt(0).includes("Blepharitis is a chronic"));
    }

    // A provider that is down or out of quota has messages of its own too.
    const { w, material } = eyelids();
    w.model.queue(new TutorError("PROVIDER_RATE_LIMITED", "gemini 429 RESOURCE_EXHAUSTED"));
    const busy = await toResult("quiz generation", () => generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A)));
    assert.equal(!busy.ok && busy.code, "PROVIDER_BUSY");
    for (const code of ["GENERATION_FAILED", "PROVIDER_BUSY", "AI_UNAVAILABLE", "NOT_CONFIGURED"] as const) {
      assert.doesNotMatch(PRACTICE_ERRORS[code], /Upload|No ready study material/);
    }
  });

  it("reports a missing AI key as a setup problem, not as missing material", async () => {
    const { w, material } = eyelids();
    w.configured = false;
    await rejectsWith(generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A)), "NOT_CONFIGURED");
    await rejectsWith(generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A)), "NOT_CONFIGURED");
  });
});

describe("isolation is unchanged by the fix", () => {
  it("never reads another user's passages, by search or in order", async () => {
    const w = practiceWorld();
    const mine = eyelids(w, USER_A);
    const theirs = w.db.addSubject(USER_B, "Private");
    const secret = w.db.addMaterial(USER_B, theirs.id, "B private slides");
    w.knowledge.add(USER_B, chunk({ content: "B SECRET: the answers to the final paper are listed here in full for user B only.", materialId: secret.id, materialTitle: secret.title, subjectId: theirs.id, score: 0.99 }));
    // Force the in-order read, the new path, for user A.
    w.knowledge.mislabelled.add(mine.material.id);
    w.model.queue({ cards: CARDS }, { questions: QUESTIONS });

    await generateDeck({ count: 10 }, practiceDeps(w, USER_A));
    await generateQuiz({ count: 5 }, practiceDeps(w, USER_A));

    assert.equal(w.knowledge.browses, 2);
    assert.ok(w.model.calls.every((_, call) => !w.model.prompt(call).includes("B SECRET") && !w.model.prompt(call).includes("B private slides")));
    assert.ok(w.db.decks.every((deck) => deck.userId === USER_A) && w.db.quizzes.every((quiz) => quiz.userId === USER_A));
  });

  it("cannot be pointed at another user's ready material", async () => {
    const w = practiceWorld();
    const { material } = eyelids(w, USER_B);
    w.knowledge.mislabelled.add(material.id);

    await rejectsWith(generateDeck({ materialId: material.id, count: 10 }, practiceDeps(w, USER_A)), "MATERIAL_NOT_FOUND");
    await rejectsWith(generateQuiz({ materialId: material.id, count: 5 }, practiceDeps(w, USER_A)), "MATERIAL_NOT_FOUND");
    // With nothing of their own, user A is told exactly that.
    await rejectsWith(generateDeck({ count: 10 }, practiceDeps(w, USER_A)), "NO_MATERIAL");
    assert.equal(w.knowledge.browses + w.model.calls.length, 0);
  });
});
