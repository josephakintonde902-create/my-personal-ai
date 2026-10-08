import { ProcessingError } from "../errors";
import type { Block, DocumentUnit, ExtractedDocument } from "./types";
import { decodeEntities, decodeUtf8, readZipEntries } from "./zip";

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;
const WANTED = /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/;

// Text of one <a:p> paragraph: its runs joined, with <a:br/> as a line break.
function paragraphText(paragraphXml: string) {
  const parts: string[] = [];
  for (const match of paragraphXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g)) {
    parts.push(match[1] === undefined ? "\n" : decodeEntities(match[1]));
  }
  return parts.join("").trim();
}

function paragraphs(xml: string) {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((match) => paragraphText(match[1])).filter(Boolean);
}

function tableText(tableXml: string) {
  return [...tableXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)]
    .map((row) =>
      [...row[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((cell) => paragraphs(cell[1]).join(" ")).join(" | "),
    )
    .filter((row) => row.replace(/[|\s]/g, ""))
    .join("\n");
}

function parseSlide(xml: string): { title?: string; blocks: Block[] } {
  const blocks: Block[] = [];
  let title: string | undefined;

  // Tables first, then removed so their cells are not read again as shapes.
  const withoutTables = xml.replace(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g, (table) => {
    const text = tableText(table);
    if (text) blocks.push({ kind: "table", text });
    return "";
  });

  const body: Block[] = [];
  for (const shape of withoutTables.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    const placeholder = shape[1].match(/<p:ph\b[^>]*\btype="([^"]+)"/)?.[1];
    // Slide numbers, dates and footers are layout furniture, not content.
    if (placeholder === "sldNum" || placeholder === "dt" || placeholder === "ftr") continue;

    const text = paragraphs(shape[1]);
    if (text.length === 0) continue;

    if ((placeholder === "title" || placeholder === "ctrTitle") && !title) {
      title = text.join(" ");
      body.unshift({ kind: "heading", text: title });
    } else {
      body.push({ kind: "paragraph", text: text.join("\n") });
    }
  }

  // Heading, body text, then tables.
  return { title, blocks: [...body, ...blocks] };
}

function parseNotes(xml: string) {
  const notes: string[] = [];
  for (const shape of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    // The notes page also holds a thumbnail of the slide and a page number.
    if (!/<p:ph\b[^>]*\btype="body"/.test(shape[1])) continue;
    notes.push(...paragraphs(shape[1]));
  }
  return notes.join("\n");
}

// Resolves "../notesSlides/notesSlide3.xml" against "ppt/slides/".
function resolveTarget(base: string, target: string) {
  const segments = (target.startsWith("/") ? target.slice(1) : base + target).split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== ".") resolved.push(segment);
  }
  return resolved.join("/");
}

function relationships(xml: string | undefined) {
  const map = new Map<string, { type: string; target: string }>();
  for (const match of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = match[0].match(/\bId="([^"]+)"/)?.[1];
    const type = match[0].match(/\bType="([^"]+)"/)?.[1];
    const target = match[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && type && target) map.set(id, { type, target });
  }
  return map;
}

// The order slides are shown in, from the presentation manifest. Falls back
// to the numbers in the file names if the manifest cannot be read.
function slideOrder(files: Record<string, string>) {
  const available = Object.keys(files).filter((name) => SLIDE_PATH.test(name));
  const rels = relationships(files["ppt/_rels/presentation.xml.rels"]);

  const ordered: string[] = [];
  for (const match of (files["ppt/presentation.xml"] ?? "").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(match[1])?.target;
    const path = target ? resolveTarget("ppt/", target) : undefined;
    if (path && available.includes(path) && !ordered.includes(path)) ordered.push(path);
  }
  if (ordered.length === available.length) return ordered;

  return available.sort((a, b) => Number(a.match(SLIDE_PATH)![1]) - Number(b.match(SLIDE_PATH)![1]));
}

// Extracts each slide's title, text, tables and speaker notes, keeping slide
// numbers. Only the slide XML is read; embedded media and macros are ignored.
export function extractPptx(bytes: Uint8Array): ExtractedDocument {
  const entries = readZipEntries(bytes, (name) => WANTED.test(name));
  const files: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) files[name] = decodeUtf8(content);

  const order = slideOrder(files);
  if (order.length === 0) throw new ProcessingError("EXTRACTION_FAILED", "pptx: no slides found");

  const units: DocumentUnit[] = order.map((path, index) => {
    const { title, blocks } = parseSlide(files[path]);

    const slideFile = path.slice(path.lastIndexOf("/") + 1);
    const notesRel = [...relationships(files[`ppt/slides/_rels/${slideFile}.rels`]).values()].find((rel) =>
      rel.type.endsWith("/notesSlide"),
    );
    const notesXml = notesRel ? files[resolveTarget("ppt/slides/", notesRel.target)] : undefined;
    const notes = notesXml ? parseNotes(notesXml) : "";
    if (notes) blocks.push({ kind: "notes", text: `Speaker notes: ${notes}` });

    return { slideNumber: index + 1, title, blocks };
  });

  return { units, pageCount: order.length };
}
