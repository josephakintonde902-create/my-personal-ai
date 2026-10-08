// Builds small, real documents in memory for the tests, so no study material
// (and nothing copyrighted) needs to be stored in the repository.
import CFB from "cfb";
import { strToU8, zipSync } from "fflate";

const encoder = new TextEncoder();

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ PDF

// A valid PDF with one page per entry; each page shows its lines of text.
// An empty array of lines produces a page with no text layer, like a scan.
export function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const pageIds: number[] = [];
  for (const lines of pages) {
    const text = lines
      .map((line, index) => `${index === 0 ? "72 720 Td" : "0 -18 Td"} (${line.replace(/([\\()])/g, "\\$1")}) Tj`)
      .join("\n");
    const stream = lines.length > 0 ? `BT\n/F1 12 Tf\n${text}\nET` : "";
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
      ),
    );
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(pdf);
}

// ------------------------------------------------------------------ DOCX

export type DocxPart =
  | { heading: string; level?: 1 | 2 }
  | { paragraph: string }
  | { table: string[][] };

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docxParagraph(text: string, style?: string) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

export function makeDocx(parts: DocxPart[]): Uint8Array {
  const body = parts
    .map((part) => {
      if ("heading" in part) return docxParagraph(part.heading, `Heading${part.level ?? 1}`);
      if ("paragraph" in part) return docxParagraph(part.paragraph);
      const rows = part.table
        .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${docxParagraph(cell)}</w:tc>`).join("")}</w:tr>`)
        .join("");
      return `<w:tbl>${rows}</w:tbl>`;
    })
    .join("");

  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W_NS}>` +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
        "</w:styles>",
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`,
    ),
  });
}

// ------------------------------------------------------------------ PPTX

export type PptxSlide = { title?: string; body?: string[]; table?: string[][]; notes?: string };

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const pptxParagraph = (text: string) => `<a:p><a:r><a:rPr lang="en-GB"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`;

function pptxShape(placeholder: string | null, paragraphs: string[]) {
  const ph = placeholder ? `<p:nvPr><p:ph type="${placeholder}"/></p:nvPr>` : "<p:nvPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:txBody><a:bodyPr/>${paragraphs.map(pptxParagraph).join("")}</p:txBody></p:sp>`;
}

// `fileOrder` lets a test store slides under file names that differ from the
// order they are shown in, as real decks do after slides are rearranged.
export function makePptx(slides: PptxSlide[], fileOrder?: number[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const fileNumbers = fileOrder ?? slides.map((_, index) => index + 1);

  slides.forEach((slide, index) => {
    const n = fileNumbers[index];
    const shapes = [
      slide.title ? pptxShape("title", [slide.title]) : "",
      slide.body ? pptxShape(null, slide.body) : "",
      pptxShape("sldNum", ["7"]),
    ].join("");
    const table = slide.table
      ? `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${slide.table
          .map((row) => `<a:tr>${row.map((cell) => `<a:tc><a:txBody>${pptxParagraph(cell)}</a:txBody></a:tc>`).join("")}</a:tr>`)
          .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
      : "";

    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P_NS}><p:cSld><p:spTree>${shapes}${table}</p:spTree></p:cSld></p:sld>`,
    );

    if (slide.notes) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>` +
          "</Relationships>",
      );
      files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P_NS}><p:cSld><p:spTree>${pptxShape("sldImg", [])}${pptxShape("body", [slide.notes])}${pptxShape("sldNum", ["7"])}</p:spTree></p:cSld></p:notes>`,
      );
    }
  });

  files["ppt/presentation.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P_NS}><p:sldIdLst>${slides
      .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      fileNumbers
        .map(
          (n, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`,
        )
        .join("") +
      "</Relationships>",
  );

  return zipSync(files);
}

// A tiny valid PNG (1x1 pixel), standing in for a photo of notes.
export const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

// ------------------------------------------------------------------ PPT

function concatBytes(parts: Uint8Array[]) {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function u32(...values: number[]) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

// One binary PowerPoint record: version and instance, type, length, payload.
function pptRecord(type: number, payload: Uint8Array, version = 0, instance = 0) {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, (instance << 4) | version, true);
  view.setUint16(2, type, true);
  view.setUint32(4, payload.length, true);
  return concatBytes([header, payload]);
}

const pptContainer = (type: number, children: Uint8Array[], instance = 0) => pptRecord(type, concatBytes(children), 0xf, instance);

// Text as PowerPoint stores it: one byte per character when every character
// fits, UTF-16 otherwise. Paragraphs are separated by carriage returns.
function pptText(textType: number, paragraphs: string[]) {
  const text = paragraphs.join("\r");
  const header = pptRecord(0x0f9f, u32(textType));
  const codes = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  if (codes.every((code) => code < 256)) return [header, pptRecord(0x0fa8, Uint8Array.from(codes))];

  const utf16 = new Uint8Array(codes.length * 2);
  const view = new DataView(utf16.buffer);
  codes.forEach((code, i) => view.setUint16(i * 2, code, true));
  return [header, pptRecord(0x0fa0, utf16)];
}

const pptShape = (textboxChildren: Uint8Array[]) => pptContainer(0xf004, [pptRecord(0xf00d, concatBytes(textboxChildren), 0xf)]);
const pptDrawing = (shapes: Uint8Array[]) => pptContainer(0x040c, [pptContainer(0xf002, [pptContainer(0xf003, shapes)])]);

function pptSlide(slide: { title?: string; body?: string[] }) {
  return pptContainer(0x03ee, [
    pptRecord(0x03ef, new Uint8Array(24), 2),
    pptDrawing([
      // The title placeholder keeps its text in the document's outline.
      ...(slide.title ? [pptShape([pptRecord(0x0f9e, u32(0))])] : []),
      ...(slide.body ? [pptShape(pptText(1, slide.body))] : []),
      // The slide-number field.
      pptShape(pptText(4, ["*"])),
    ]),
  ]);
}

type PptSlide = { title?: string; body?: string[]; notes?: string };

// A legacy .ppt presentation. `staleFirstSlide` adds an earlier saved version
// of slide 1 with that text, left behind in the file the way PowerPoint's
// incremental saves leave them; a correct reader ignores it.
export function makePpt(slides: PptSlide[], staleFirstSlide?: string): Uint8Array {
  const DOCUMENT_ID = 1;
  const slideId = (index: number) => 256 + index;
  const slidePersistId = (index: number) => 2 + index;
  const withNotes = slides.map((slide, index) => ({ slide, index })).filter((entry) => entry.slide.notes);
  const notesPersistId = (position: number) => 2 + slides.length + position;

  const persist = (persistId: number, textCount: number, id: number) => pptRecord(0x03f3, u32(persistId, 0, textCount, id, 0));
  const document = pptContainer(0x03e8, [
    pptRecord(0x03e9, new Uint8Array(40), 1),
    pptContainer(0x0ff0, slides.flatMap((slide, index) => [
      persist(slidePersistId(index), slide.title ? 1 : 0, slideId(index)),
      ...(slide.title ? pptText(0, [slide.title]) : []),
    ]), 0),
    pptContainer(0x0ff0, withNotes.map((_, position) => persist(notesPersistId(position), 0, 1024 + position)), 2),
  ]);

  const parts: Uint8Array[] = [];
  let length = 0;
  const place = (bytes: Uint8Array) => {
    const offset = length;
    parts.push(bytes);
    length += bytes.length;
    return offset;
  };
  const directory = (offsets: number[]) => place(pptRecord(0x1772, u32(offsets.length * 2 ** 20 + 1, ...offsets)));
  const userEdit = (previousEdit: number, directoryOffset: number, idCount: number) =>
    place(pptRecord(0x0ff5, concatBytes([u32(slideId(slides.length - 1), 0x03000dbc, previousEdit, directoryOffset, DOCUMENT_ID, idCount + 1), new Uint8Array(4)])));

  const documentOffset = place(document);

  let previousEdit = 0;
  if (staleFirstSlide !== undefined) {
    const staleOffset = place(pptSlide({ body: [staleFirstSlide] }));
    previousEdit = userEdit(0, directory([documentOffset, staleOffset]), 2);
  }

  const offsets = [documentOffset];
  for (const slide of slides) offsets.push(place(pptSlide(slide)));
  for (const { slide, index } of withNotes) {
    offsets.push(place(pptContainer(0x03f0, [
      pptRecord(0x03f1, concatBytes([u32(slideId(index)), new Uint8Array(4)]), 1),
      pptDrawing([pptShape(pptText(2, [slide.notes!]))]),
    ])));
  }
  const currentEdit = userEdit(previousEdit, directory(offsets), offsets.length);

  const currentUser = pptRecord(0x0ff6, concatBytes([u32(0x14, 0xe391c05f, currentEdit), Uint8Array.of(0, 0, 0xf4, 0x03, 3, 0, 0, 0)]));

  const file = CFB.utils.cfb_new();
  CFB.utils.cfb_add(file, "/PowerPoint Document", concatBytes(parts));
  CFB.utils.cfb_add(file, "/Current User", currentUser);
  return new Uint8Array(CFB.write(file, { type: "buffer" }) as Uint8Array);
}

// A compound file that is not a presentation (the same container holds old
// Word and Excel files).
export function makeCompoundFile(streamName: string): Uint8Array {
  const file = CFB.utils.cfb_new();
  CFB.utils.cfb_add(file, `/${streamName}`, new Uint8Array(64));
  return new Uint8Array(CFB.write(file, { type: "buffer" }) as Uint8Array);
}
