import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToBlocks } from "@/lib/ai/documents/docx";
import { extractDocument } from "@/lib/ai/documents/extract";
import { decodeText } from "@/lib/ai/documents/text";
import { decodeEntities } from "@/lib/ai/documents/zip";
import { ProcessingError } from "@/lib/ai/errors";
import { makeCompoundFile, makeDocx, makePdf, makePpt, makePptx, PNG_BYTES } from "./fixtures";

const utf8 = (text: string) => new TextEncoder().encode(text);
const extract = (typeId: string, bytes: Uint8Array) => extractDocument({ bytes, typeId, mimeType: "" });
const texts = (blocks: { text: string }[]) => blocks.map((block) => block.text);

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof ProcessingError && error.code === code);
}

describe("TXT extraction", () => {
  it("splits paragraphs on blank lines", async () => {
    const document = await extract("txt", utf8("First paragraph\nstill first.\r\n\r\nSecond paragraph.\n\n\n\nThird."));
    assert.deepEqual(texts(document.units[0].blocks), ["First paragraph\nstill first.", "Second paragraph.", "Third."]);
    assert.equal(document.needsOcr, undefined);
  });

  it("keeps unusual characters intact", async () => {
    const source = "Naïve café — “quoted” 日本語 Ωμέγα x² ≤ y ∑ αβγ 🙂";
    const document = await extract("txt", utf8(source));
    assert.equal(document.units[0].blocks[0].text, source);
  });

  it("decodes Windows-1252 and UTF-16 instead of garbling them", () => {
    // "café" in Windows-1252: é is the single byte 0xE9, which is invalid UTF-8.
    assert.equal(decodeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])), "café");
    // UTF-16LE with a byte-order mark.
    assert.equal(decodeText(Uint8Array.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])), "Hi");
  });

  it("rejects a file with no bytes", async () => {
    await rejectsWith(extract("txt", new Uint8Array()), "EMPTY_DOCUMENT");
  });
});

describe("PDF extraction", () => {
  it("extracts text page by page with page numbers", async () => {
    const document = await extract(
      "pdf",
      makePdf([
        ["Introduction to refraction", "Light bends when it changes medium."],
        ["Snell's law relates the angles."],
        ["Summary (final page)."],
      ]),
    );

    assert.equal(document.pageCount, 3);
    assert.deepEqual(document.units.map((unit) => unit.pageNumber), [1, 2, 3]);
    assert.match(document.units[0].blocks.map((b) => b.text).join(" "), /Introduction to refraction[\s\S]*Light bends/);
    assert.match(document.units[1].blocks[0].text, /Snell's law/);
    assert.match(document.units[2].blocks[0].text, /Summary \(final page\)\./);
    assert.equal(document.needsOcr, false);
  });

  it("flags a PDF with no text layer as needing OCR", async () => {
    const document = await extract("pdf", makePdf([[], []]));
    assert.equal(document.pageCount, 2);
    assert.equal(document.needsOcr, true);
  });

  it("fails cleanly on a damaged file", async () => {
    await rejectsWith(extract("pdf", utf8("this is not a pdf at all")), "EXTRACTION_FAILED");
  });
});

describe("DOCX extraction", () => {
  it("preserves headings, paragraphs and tables in order", async () => {
    const document = await extract(
      "docx",
      makeDocx([
        { heading: "Cell Biology" },
        { paragraph: "The cell is the basic unit of life." },
        { heading: "Organelles", level: 2 },
        { paragraph: "Mitochondria produce ATP & regulate metabolism." },
        { table: [["Organelle", "Function"], ["Nucleus", "Stores DNA"], ["Ribosome", "Builds proteins"]] },
        { paragraph: "End of notes — naïve café 日本語." },
      ]),
    );

    assert.deepEqual(document.units[0].blocks, [
      { kind: "heading", text: "Cell Biology" },
      { kind: "paragraph", text: "The cell is the basic unit of life." },
      { kind: "heading", text: "Organelles" },
      { kind: "paragraph", text: "Mitochondria produce ATP & regulate metabolism." },
      { kind: "table", text: "Organelle | Function\nNucleus | Stores DNA\nRibosome | Builds proteins" },
      { kind: "paragraph", text: "End of notes — naïve café 日本語." },
    ]);
  });

  it("handles nested lists and multi-paragraph cells", () => {
    const blocks = htmlToBlocks(
      "<h1>Title</h1><ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>" +
        "<table><tr><td><p>A</p><p>more A</p></td><td><p>B</p></td></tr></table><p>After &lt;tag&gt; &amp; text</p>",
    );
    assert.deepEqual(blocks, [
      { kind: "heading", text: "Title" },
      { kind: "paragraph", text: "• One" },
      { kind: "paragraph", text: "• Nested" },
      { kind: "paragraph", text: "• Two" },
      { kind: "table", text: "A more A | B" },
      { kind: "paragraph", text: "After <tag> & text" },
    ]);
  });

  it("fails cleanly on a file that is not a Word document", async () => {
    await rejectsWith(extract("docx", utf8("plain text pretending to be docx")), "EXTRACTION_FAILED");
  });
});

describe("PPTX extraction", () => {
  it("extracts titles, text, tables and notes with slide numbers", async () => {
    const document = await extract(
      "pptx",
      makePptx([
        { title: "Ocular Anatomy", body: ["The cornea refracts light.", "The lens fine-tunes focus."], notes: "Mention the tear film." },
        { title: "Layers", table: [["Layer", "Role"], ["Retina", "Detects light"]] },
        { body: ["A slide with no title."] },
      ]),
    );

    assert.equal(document.pageCount, 3);
    assert.deepEqual(document.units.map((unit) => unit.slideNumber), [1, 2, 3]);
    assert.deepEqual(document.units.map((unit) => unit.title), ["Ocular Anatomy", "Layers", undefined]);
    assert.deepEqual(document.units[0].blocks, [
      { kind: "heading", text: "Ocular Anatomy" },
      { kind: "paragraph", text: "The cornea refracts light.\nThe lens fine-tunes focus." },
      { kind: "notes", text: "Speaker notes: Mention the tear film." },
    ]);
    assert.deepEqual(document.units[1].blocks, [
      { kind: "heading", text: "Layers" },
      { kind: "table", text: "Layer | Role\nRetina | Detects light" },
    ]);
    // The slide-number placeholder ("7") is layout, not content.
    assert.ok(!JSON.stringify(document.units).includes('"7"'));
  });

  it("follows presentation order, not file names", async () => {
    // Shown first, but stored as slide2.xml.
    const document = await extract("pptx", makePptx([{ title: "Shown first" }, { title: "Shown second" }], [2, 1]));
    assert.deepEqual(document.units.map((unit) => unit.title), ["Shown first", "Shown second"]);
  });

  it("fails cleanly when the archive has no slides", async () => {
    await rejectsWith(extract("pptx", makeDocx([{ paragraph: "not a deck" }])), "EXTRACTION_FAILED");
  });
});

describe("PPT (legacy PowerPoint) extraction", () => {
  it("extracts titles, text and notes with slide numbers", async () => {
    const document = await extract(
      "ppt",
      makePpt([
        { title: "Ocular Anatomy", body: ["The cornea refracts light.", "The lens fine-tunes focus."], notes: "Mention the tear film." },
        { body: ["A slide with no title."] },
        { title: "Layers", body: ["Retina"], notes: "Ask which layer detects light." },
      ]),
    );

    assert.equal(document.pageCount, 3);
    assert.deepEqual(document.units.map((unit) => unit.slideNumber), [1, 2, 3]);
    assert.deepEqual(document.units.map((unit) => unit.title), ["Ocular Anatomy", undefined, "Layers"]);
    assert.deepEqual(document.units[0].blocks, [
      { kind: "heading", text: "Ocular Anatomy" },
      { kind: "paragraph", text: "The cornea refracts light.\nThe lens fine-tunes focus." },
      { kind: "notes", text: "Speaker notes: Mention the tear film." },
    ]);
    assert.deepEqual(document.units[1].blocks, [{ kind: "paragraph", text: "A slide with no title." }]);
    // Notes stay with their own slide, and the slide-number field is not content.
    assert.equal(document.units[2].blocks[2].text, "Speaker notes: Ask which layer detects light.");
    assert.ok(!JSON.stringify(document.units).includes('"*"'));
  });

  it("keeps accented and non-Latin text intact", async () => {
    const document = await extract("ppt", makePpt([{ title: "Café naïve é", body: ["日本語 Ωμέγα x² ≤ y"] }]));
    assert.deepEqual(texts(document.units[0].blocks), ["Café naïve é", "日本語 Ωμέγα x² ≤ y"]);
  });

  it("reads the latest saved version of a slide, not an older one left in the file", async () => {
    const document = await extract("ppt", makePpt([{ title: "Current", body: ["Up to date text."] }], "Outdated text."));
    assert.equal(document.pageCount, 1);
    assert.deepEqual(texts(document.units[0].blocks), ["Current", "Up to date text."]);
  });

  it("handles a large presentation", async () => {
    const slides = Array.from({ length: 120 }, (_, i) => ({ title: `Slide ${i + 1}`, body: ["word ".repeat(200).trim()], notes: `Note ${i + 1}` }));
    const document = await extract("ppt", makePpt(slides));
    assert.equal(document.units.length, 120);
    assert.equal(document.units[119].title, "Slide 120");
    assert.equal(document.units[119].blocks[2].text, "Speaker notes: Note 120");
  });

  it("fails cleanly on files that are not PowerPoint presentations", async () => {
    await rejectsWith(extract("ppt", utf8("plain text pretending to be a ppt")), "EXTRACTION_FAILED");
    await rejectsWith(extract("ppt", makeCompoundFile("WordDocument")), "EXTRACTION_FAILED");
    // A .pptx renamed to .ppt is a zip archive, not a compound file.
    await rejectsWith(extract("ppt", makePptx([{ title: "Wrong container" }])), "EXTRACTION_FAILED");
  });

  it("fails cleanly on a truncated presentation", async () => {
    const whole = makePpt([{ title: "Cut off", body: ["Text"] }]);
    await rejectsWith(extract("ppt", whole.slice(0, Math.floor(whole.length / 2))), "EXTRACTION_FAILED");
  });
});

describe("images and unknown types", () => {
  it("sends images to OCR instead of treating them as empty", async () => {
    const document = await extract("png", PNG_BYTES);
    assert.equal(document.needsOcr, true);
    assert.deepEqual(document.units, []);
  });

  it("rejects types it has no extractor for", async () => {
    await rejectsWith(extract("exe", utf8("MZ")), "UNSUPPORTED_FILE");
  });
});

describe("entity decoding", () => {
  it("decodes named and numeric references", () => {
    assert.equal(decodeEntities("a &amp; b &lt; c &#233; &#x1F642; &unknown;"), "a & b < c é 🙂 &unknown;");
  });
});
