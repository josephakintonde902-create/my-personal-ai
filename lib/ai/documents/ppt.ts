import CFB from "cfb";
import { ProcessingError } from "../errors";
import type { Block, DocumentUnit, ExtractedDocument } from "./types";

// Legacy PowerPoint (.ppt, PowerPoint 97–2003). The file is an OLE compound
// file whose "PowerPoint Document" stream is a tree of binary records. Only
// text records are read; embedded objects, pictures and macros are ignored.
//
// Record types, from Microsoft's [MS-PPT] specification.
const DOCUMENT = 0x03e8;
const NOTES_ATOM = 0x03f1;
const SLIDE_PERSIST_ATOM = 0x03f3;
const OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const TEXT_HEADER_ATOM = 0x0f9f;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const SLIDE_LIST_WITH_TEXT = 0x0ff0;
const USER_EDIT_ATOM = 0x0ff5;
const PERSIST_DIRECTORY_ATOM = 0x1772;
const CLIENT_TEXTBOX = 0xf00d;

// SlideListWithText instances.
const SLIDES = 0;
const NOTES = 2;

// TextHeaderAtom text types.
const TITLE_TYPES = new Set([0, 6]);
const NOTES_TYPE = 2;

const ENCRYPTED_TOKEN = 0xf3d1c4df;
const HEADER_SIZE = 8;
const MAX_DEPTH = 32;

type RecordHeader = { version: number; instance: number; type: number; start: number; end: number };
type Text = { type: number; text: string };

class Stream {
  private readonly view: DataView;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  uint32(offset: number) {
    return offset >= 0 && offset + 4 <= this.bytes.length ? this.view.getUint32(offset, true) : 0;
  }

  // The record starting at `offset`, or null if it does not fit before `limit`.
  record(offset: number, limit = this.bytes.length): RecordHeader | null {
    if (offset < 0 || offset + HEADER_SIZE > limit) return null;
    const versionAndInstance = this.view.getUint16(offset, true);
    const start = offset + HEADER_SIZE;
    const end = start + this.view.getUint32(offset + 4, true);
    if (end > limit) return null;
    return { version: versionAndInstance & 0xf, instance: versionAndInstance >> 4, type: this.view.getUint16(offset + 2, true), start, end };
  }

  // The records directly inside a container.
  *children(parent: { start: number; end: number }) {
    let offset = parent.start;
    while (true) {
      const record = this.record(offset, parent.end);
      if (!record) return;
      yield record;
      offset = record.end;
    }
  }

  text(record: RecordHeader) {
    const bytes = this.bytes.subarray(record.start, record.end);
    let raw = "";
    if (record.type === TEXT_CHARS_ATOM) {
      raw = new TextDecoder("utf-16le").decode(bytes);
    } else {
      // TextBytesAtom stores one byte per character: the character's code.
      for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    // Paragraphs end with a carriage return, line breaks are vertical tabs.
    return raw.replace(/[\r\v]/g, "\n").replace(/[\u0000-\u0008\u000c\u000e-\u001f]/g, "").trim();
  }
}

// Where each saved object lives in the stream. A file can hold several
// generations of edits; the newest location of each object wins.
function readPersistDirectory(stream: Stream, currentEditOffset: number) {
  const offsets = new Map<number, number>();
  const visited = new Set<number>();
  let documentId = 0;

  for (let editOffset = currentEditOffset; editOffset > 0 && !visited.has(editOffset); ) {
    visited.add(editOffset);
    const edit = stream.record(editOffset);
    if (!edit || edit.type !== USER_EDIT_ATOM) break;
    if (!documentId) documentId = stream.uint32(edit.start + 16);

    const directory = stream.record(stream.uint32(edit.start + 12));
    if (directory?.type === PERSIST_DIRECTORY_ATOM) {
      for (let at = directory.start; at + 4 <= directory.end; ) {
        const entry = stream.uint32(at);
        const firstId = entry & 0xfffff;
        const count = entry >>> 20;
        at += 4;
        for (let i = 0; i < count && at + 4 <= directory.end; i++, at += 4) {
          if (!offsets.has(firstId + i)) offsets.set(firstId + i, stream.uint32(at));
        }
      }
    }
    editOffset = stream.uint32(edit.start + 8);
  }

  return { offsets, documentId };
}

type ListedSlide = { persistId: number; slideId: number; outline: Text[] };

// The document's list of slides (or notes pages) in presentation order, each
// with the placeholder text PowerPoint keeps for the outline view.
function readSlideList(stream: Stream, document: RecordHeader, instance: number) {
  const listed: ListedSlide[] = [];
  for (const list of stream.children(document)) {
    if (list.type !== SLIDE_LIST_WITH_TEXT || list.instance !== instance) continue;

    let textType = 0;
    for (const record of stream.children(list)) {
      if (record.type === SLIDE_PERSIST_ATOM) {
        listed.push({ persistId: stream.uint32(record.start), slideId: stream.uint32(record.start + 12), outline: [] });
      } else if (record.type === TEXT_HEADER_ATOM) {
        textType = stream.uint32(record.start);
      } else if ((record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM) && listed.length > 0) {
        listed[listed.length - 1].outline.push({ type: textType, text: stream.text(record) });
      }
    }
  }
  return listed;
}

// Every piece of text in the shapes of one slide or notes page, in the order
// the shapes are stored. A placeholder may hold its text in the outline
// instead and only point at it.
function readShapeTexts(stream: Stream, container: RecordHeader, outline: Text[]) {
  const texts: Text[] = [];
  let slideIdRef = 0;

  const walk = (parent: RecordHeader, depth: number, inTextbox: boolean) => {
    let textType = 4;
    for (const record of stream.children(parent)) {
      if (record.type === NOTES_ATOM) {
        slideIdRef = stream.uint32(record.start);
      } else if (inTextbox && record.type === TEXT_HEADER_ATOM) {
        textType = stream.uint32(record.start);
      } else if (inTextbox && (record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM)) {
        texts.push({ type: textType, text: stream.text(record) });
      } else if (inTextbox && record.type === OUTLINE_TEXT_REF_ATOM) {
        const referenced = outline[stream.uint32(record.start)];
        if (referenced) texts.push(referenced);
      } else if ((record.version === 0xf || record.type === CLIENT_TEXTBOX) && depth < MAX_DEPTH) {
        walk(record, depth + 1, inTextbox || record.type === CLIENT_TEXTBOX);
      }
    }
  };
  walk(container, 0, false);

  // "*" is the field PowerPoint replaces with the slide number.
  return { texts: texts.filter((item) => item.text && item.text !== "*"), slideIdRef };
}

function readStreams(bytes: Uint8Array) {
  try {
    const container = CFB.read(bytes, { type: "array" });
    const content = (name: string) => {
      const entry = CFB.find(container, name);
      return entry?.content ? Uint8Array.from(entry.content as ArrayLike<number>) : null;
    };
    return { document: content("PowerPoint Document"), currentUser: content("Current User") };
  } catch (error) {
    throw new ProcessingError("EXTRACTION_FAILED", `ppt: not a readable compound file: ${(error as Error).message}`);
  }
}

// Extracts each slide's title, text and speaker notes, keeping slide numbers.
export function extractPpt(bytes: Uint8Array): ExtractedDocument {
  const streams = readStreams(bytes);
  if (!streams.document || !streams.currentUser) {
    throw new ProcessingError("EXTRACTION_FAILED", "ppt: not a PowerPoint presentation");
  }

  // CurrentUserAtom: record header, size, header token, offset of the newest edit.
  const currentUser = new Stream(streams.currentUser);
  if (currentUser.uint32(12) === ENCRYPTED_TOKEN) {
    throw new ProcessingError("EXTRACTION_FAILED", "ppt: presentation is encrypted");
  }

  const stream = new Stream(streams.document);
  const { offsets, documentId } = readPersistDirectory(stream, currentUser.uint32(16));
  const document = stream.record(offsets.get(documentId) ?? -1);
  if (!document || document.type !== DOCUMENT) {
    throw new ProcessingError("EXTRACTION_FAILED", "ppt: document record not found");
  }

  const containerOf = (listed: ListedSlide) => stream.record(offsets.get(listed.persistId) ?? -1);

  // Speaker notes, keyed by the slide they belong to.
  const notesBySlide = new Map<number, string>();
  for (const listed of readSlideList(stream, document, NOTES)) {
    const container = containerOf(listed);
    if (!container) continue;
    const { texts, slideIdRef } = readShapeTexts(stream, container, listed.outline);
    const notes = texts.filter((item) => item.type === NOTES_TYPE).map((item) => item.text).join("\n");
    if (notes && slideIdRef) notesBySlide.set(slideIdRef, notes);
  }

  const slides = readSlideList(stream, document, SLIDES);
  if (slides.length === 0) throw new ProcessingError("EXTRACTION_FAILED", "ppt: no slides found");

  const units: DocumentUnit[] = slides.map((listed, index) => {
    const container = containerOf(listed);
    let texts = container ? readShapeTexts(stream, container, listed.outline).texts : [];
    // A slide whose shapes could not be read still has its outline text.
    if (texts.length === 0) texts = listed.outline.filter((item) => item.text && item.text !== "*");

    const blocks: Block[] = [];
    let title: string | undefined;
    for (const item of texts) {
      if (TITLE_TYPES.has(item.type) && !title) {
        title = item.text.replace(/\s*\n\s*/g, " ");
        blocks.unshift({ kind: "heading", text: title });
      } else {
        blocks.push({ kind: "paragraph", text: item.text });
      }
    }

    const notes = notesBySlide.get(listed.slideId);
    if (notes) blocks.push({ kind: "notes", text: `Speaker notes: ${notes}` });

    return { slideNumber: index + 1, title, blocks };
  });

  return { units, pageCount: slides.length };
}
