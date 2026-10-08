import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkDocument, embeddingInput, splitLongText } from "@/lib/ai/chunking/chunker";
import { CHARS_PER_TOKEN, CHUNKING } from "@/lib/ai/config";
import { cleanDocument, countWords, normalizeText } from "@/lib/ai/documents/clean";
import type { DocumentUnit, ExtractedDocument } from "@/lib/ai/documents/types";

const B = String.fromCharCode;
const paragraph = (text: string) => ({ kind: "paragraph" as const, text });
const heading = (text: string) => ({ kind: "heading" as const, text });

// Distinct sentences, so overlap and ordering can be checked by content.
const sentences = (label: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${label} sentence number ${i + 1} explains one more idea in plain words.`).join(" ");

describe("text normalization", () => {
  it("collapses whitespace without touching the words", () => {
    assert.equal(normalizeText("  Hello \t  world  \r\n\r\n\r\n\r\nNext   line \n"), "Hello world\n\nNext line");
  });

  it("removes invisible characters and odd spaces", () => {
    const messy = `Zero${B(0x200b)}width, soft${B(0xad)}hyphen, nb${B(0xa0)}space, bom${B(0xfeff)}, nul${B(0)}, bad${B(0xfffd)}.`;
    assert.equal(normalizeText(messy), "Zerowidth, softhyphen, nb space, bom, nul, bad.");
  });

  it("expands ligatures and composes accents", () => {
    assert.equal(normalizeText(`e${B(0xfb03)}cient ${B(0xfb01)}eld`), "efficient field");
    // "e" followed by a combining acute accent becomes the single character é.
    assert.equal(normalizeText(`cafe${B(0x301)}`), "café");
  });

  it("stays faithful to the source", () => {
    const source = "E = mc² — “quoted”, 50% of x ≤ y; don't re-order: 1) first 2) second. 日本語";
    assert.equal(normalizeText(source), source);
  });
});

describe("document cleaning", () => {
  it("drops empty blocks and empty units", () => {
    const cleaned = cleanDocument({
      units: [{ blocks: [paragraph("  Real text  "), paragraph(" \n\t ")] }, { blocks: [paragraph("")] }],
    });
    assert.deepEqual(cleaned.units, [{ title: undefined, blocks: [paragraph("Real text")] }]);
    assert.equal(countWords(cleaned), 2);
  });

  it("removes running headers and footers but keeps body text", () => {
    const units: DocumentUnit[] = Array.from({ length: 6 }, (_, i) => ({
      pageNumber: i + 1,
      blocks: [paragraph(`BIO101 Lecture Notes\nBody of page ${i + 1} about cells.\nPage ${i + 1} of 6`)],
    }));
    const cleaned = cleanDocument({ units });

    assert.equal(cleaned.units.length, 6);
    assert.equal(cleaned.units[2].blocks[0].text, "Body of page 3 about cells.");
    assert.ok(!JSON.stringify(cleaned).includes("BIO101"));
    assert.ok(!JSON.stringify(cleaned).includes("of 6"));
  });

  it("leaves short documents alone", () => {
    const units: DocumentUnit[] = [1, 2].map((n) => ({ pageNumber: n, blocks: [paragraph(`Same title\nBody ${n}`)] }));
    assert.equal(cleanDocument({ units }).units[0].blocks[0].text, "Same title\nBody 1");
  });
});

describe("chunking", () => {
  const maxChars = CHUNKING.maxTokens * CHARS_PER_TOKEN;

  it("keeps a short document as one chunk", () => {
    const chunks = chunkDocument({ units: [{ blocks: [heading("Intro"), paragraph("A short note.")] }] });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, "Intro\n\nA short note.");
    assert.equal(chunks[0].index, 0);
    assert.equal(chunks[0].sectionTitle, "Intro");
    assert.equal(chunks[0].tokenCount, Math.ceil(chunks[0].content.length / CHARS_PER_TOKEN));
  });

  it("never exceeds the maximum size and numbers chunks in order", () => {
    const document: ExtractedDocument = {
      units: [{ blocks: Array.from({ length: 60 }, (_, i) => paragraph(sentences(`P${i}`, 8))) }],
    };
    const chunks = chunkDocument(document);

    assert.ok(chunks.length > 5);
    chunks.forEach((chunk, i) => {
      assert.equal(chunk.index, i);
      assert.ok(chunk.content.length <= maxChars, `chunk ${i} is ${chunk.content.length} chars`);
      assert.ok(chunk.tokenCount <= CHUNKING.maxTokens);
    });
    // Chunks are filled close to the target rather than cut small.
    const average = chunks.slice(0, -1).reduce((sum, c) => sum + c.tokenCount, 0) / (chunks.length - 1);
    assert.ok(average > CHUNKING.targetTokens * 0.7, `average ${average}`);
  });

  it("overlaps consecutive chunks and loses no text", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => sentences(`Para${i}`, 8));
    const chunks = chunkDocument({ units: [{ blocks: paragraphs.map(paragraph) }] });

    for (let i = 1; i < chunks.length; i++) {
      const opening = chunks[i].content.slice(0, 120);
      assert.ok(chunks[i - 1].content.includes(opening), `chunk ${i} does not start with text from chunk ${i - 1}`);
    }
    for (const text of paragraphs) {
      assert.ok(chunks.some((chunk) => chunk.content.includes(text)), "a paragraph was split or dropped");
    }
  });

  it("starts a new chunk at a heading once the current one has substance", () => {
    const chunks = chunkDocument({
      units: [
        {
          blocks: [
            heading("Mitosis"),
            paragraph(sentences("Mitosis", 30)),
            heading("Meiosis"),
            paragraph(sentences("Meiosis", 5)),
          ],
        },
      ],
    });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].sectionTitle, "Mitosis");
    assert.equal(chunks[1].sectionTitle, "Meiosis");
    assert.ok(chunks[1].content.startsWith("Meiosis\n\n"));
    // A new section starts clean, with no text carried over from the last one.
    assert.ok(!chunks[1].content.includes("Mitosis sentence"));
  });

  it("does not break at a heading when the chunk is still small", () => {
    const chunks = chunkDocument({
      units: [{ blocks: [heading("A"), paragraph("Tiny."), heading("B"), paragraph("Also tiny.")] }],
    });
    assert.equal(chunks.length, 1);
  });

  it("records the page each chunk starts on", () => {
    const units: DocumentUnit[] = [1, 2, 3, 4].map((pageNumber) => ({
      pageNumber,
      blocks: [paragraph(sentences(`Page${pageNumber}`, 45))],
    }));
    const chunks = chunkDocument({ units, pageCount: 4 });

    assert.deepEqual([...new Set(chunks.map((c) => c.pageNumber))], [1, 2, 3, 4]);
    for (const chunk of chunks) {
      assert.equal(chunk.slideNumber, undefined);
      const firstNewText = chunk.content.split("\n\n").at(-1)!;
      assert.ok(firstNewText.includes(`Page${chunk.pageNumber} sentence`) || chunk.content.includes(`Page${chunk.pageNumber} sentence`));
    }
  });

  it("uses slide titles as section titles and keeps slide numbers", () => {
    const units: DocumentUnit[] = [
      { slideNumber: 1, title: "Cornea", blocks: [heading("Cornea"), paragraph(sentences("Cornea", 40))] },
      { slideNumber: 2, title: "Lens", blocks: [heading("Lens"), paragraph(sentences("Lens", 40))] },
      { slideNumber: 3, blocks: [paragraph(sentences("Untitled", 40))] },
    ];
    const chunks = chunkDocument({ units });

    assert.deepEqual(chunks.map((c) => [c.slideNumber, c.sectionTitle, c.pageNumber]), [
      [1, "Cornea", undefined],
      [2, "Lens", undefined],
      [3, undefined, undefined],
    ]);
  });

  it("splits one oversized paragraph at sentence ends", () => {
    const chunks = chunkDocument({ units: [{ blocks: [paragraph(sentences("Long", 400))] }] });

    assert.ok(chunks.length > 3);
    for (const chunk of chunks) {
      assert.ok(chunk.content.length <= maxChars);
      assert.match(chunk.content, /\.$/, "a chunk ended mid-sentence");
    }
  });

  it("hard-splits text that has no sentence breaks at all", () => {
    const parts = splitLongText("word ".repeat(3000).trim(), 1000);
    assert.ok(parts.every((part) => part.length <= 1000));
    assert.ok(parts.every((part) => /^word( word)*$/.test(part)), "a word was cut in half");
    assert.equal(parts.join(" ").split(" ").length, 3000);
  });

  it("returns nothing for an empty document", () => {
    assert.deepEqual(chunkDocument({ units: [] }), []);
  });

  it("adds the section title to the embedded text only when it is missing", () => {
    assert.equal(embeddingInput({ content: "Lens\n\nFocuses light.", sectionTitle: "Lens" }), "Lens\n\nFocuses light.");
    assert.equal(embeddingInput({ content: "It focuses light.", sectionTitle: "Lens" }), "Lens\n\nIt focuses light.");
    assert.equal(embeddingInput({ content: "No section." }), "No section.");
  });
});
