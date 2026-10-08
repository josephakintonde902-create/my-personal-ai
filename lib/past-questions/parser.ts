import type { ExtractedDocument } from "@/lib/ai/documents/types";
import { PAST } from "./config";
import type { ParsedQuestion } from "./types";

// Reads questions out of the text of a past paper. Deterministic: no AI
// model is involved, so the same paper always gives the same questions and
// nothing is ever invented.
//
// It recognises the layouts papers commonly use:
//   * numbered questions ("1.", "1)", "Q1.", "Question 1:")
//   * lettered options, one per line or several on a line ("A. … B. … C. …")
//   * sub-questions ("1a.", "1(b)", or "(a) … (b) …" under a question)
//   * questions and options that continue on the next line or the next page
//   * an answer after the question ("Answer: B") with an optional explanation
//   * an answer key, after the questions it belongs to or at the very end
//
// The rule throughout is to prefer doing less. An answer is recorded only
// when the paper states it. Text that cannot be read as a question with
// confidence is kept word for word as a 'raw' entry, never tidied into
// something it might not be.

export type ParseOptions = {
  // The collection's year, used for questions the paper does not date itself.
  year?: number | null;
  // False when question numbers were reconstructed rather than printed (Word
  // automatic numbering). An answer key is then not matched by number, since
  // a wrong match would present a wrong answer as official.
  trustNumbers?: boolean;
};

export type ParseResult = {
  questions: ParsedQuestion[];
  // Questions recognised as such (everything that is not 'raw').
  structured: number;
  raw: number;
  // Structured questions with an answer from the paper.
  withAnswers: number;
  // True when the paper was cut off at the size limit.
  truncated: boolean;
};

type Line = { text: string; page: number | null; slide: number | null; heading: boolean };
type Item = { letter: string; text: string };
type Draft = {
  number: number | null;
  sub: string | null;
  stem: string[];
  items: Item[];
  answer: string | null;
  explanation: string[];
  mode: "stem" | "options" | "answer" | "explanation";
  // The next number expected in a numbered list inside the question itself
  // ("Which of these are true? 1. … 2. … 3. …"). Null when there is none.
  inner: number | null;
  // Every line that went into the question, as extracted.
  lines: string[];
  page: number | null;
  slide: number | null;
  year: number | null;
};
// A parsed question with what is needed to match it to an answer key.
// `choices` is kept for a true/false question printed as "A. True  B. False",
// so that an answer given as a letter can still be read.
type Entry = ParsedQuestion & { label: string | null; instruction: boolean; choices?: string[] };

const PAGE_MARK = /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
// "1.", "1)", "Q1.", "Question 1:", "1a.", "1(a)" — then the question's text.
const QUESTION_START = /^(?:q(?:uestion|n)?\.?\s*)?(\d{1,3})(?:\s*\(([a-h])\)\s*[.):\-–]?|([a-h])?\s*[.):\-–])\s+(\S.*)$/i;
// A number alone on its line, its text following on the next.
const QUESTION_LABEL = /^(?:(?:q(?:uestion|n)?\.?\s*)(\d{1,3})\s*[.):\-–]?|(\d{1,3})\s*[.)])$/i;
// The space after the letter's full stop keeps "e.g. …" from reading as option E.
const OPTION = /^\(?([A-Fa-f])\s*[.)](?:\s+(\S.*))?$/;
const INLINE_OPTION = /(?:^|\s)\(?([A-Fa-f])[.)]\s+/g;
// "Answer: B", "Ans - B", "The correct answer is B", and "Ans. B" when all
// that follows is an option letter.
const ANSWER = /^(?:the\s+)?(?:correct\s+)?(?:answer|ans)\.?(?:\s*[:\-–=]\s*|\s+is\s*:?\s+|\s+(?=\(?[A-Fa-f]\)?[.)]?$))(\S.*)$/i;
// A key that starts on its heading's own line: "Answers: 1.B 2.A 3.C".
const INLINE_KEY = /^(?:the\s+)?(?:answers?(?:\s+keys?)?|keys?)\s*[:\-–]\s*(\d.*)$/i;
const EXPLANATION = /^(?:explanation|rationale|reason|solution)\s*[:\-–]\s*(.*)$/i;
const SECTION = /^(?:section|part|paper)\s+[A-Z0-9]{1,4}\b/i;
const KEY_HEADING = /^(?:the\s+)?(?:answers?(?:\s+keys?|\s+sheet)?|marking\s+(?:scheme|guide)|solutions?|correct\s+answers?|model\s+answers?)(?:\s+(?:to|for)\s+.{1,40})?\s*[:.\-–]?$/i;
const KEY_ENTRY = /(\d{1,3})\s*([a-h])?\s*[.):\-–=]?\s*\(?(true|false|[A-Fa-f]|t)\)?(?=$|[\s,;|])/gi;
const KEY_TEXT = /^(\d{1,3})\s*([a-h])?\s*[.):\-–]\s+(\S.+)$/i;
const YEAR = /\b(19[5-9]\d|20\d\d)\b/g;
const SUB_QUESTION = /\?\s*(?:[([]\s*\d+\s*marks?\s*[)\]])?$|[([]\s*\d+\s*marks?\s*[)\]]|^(?:explain|describe|state|list|define|discuss|outline|give|name|mention|calculate|draw|differentiate|distinguish|compare|what|why|how|write|enumerate|identify|briefly|with the aid)\b/i;
const INSTRUCTION = /^(?:answer|attempt|read|write|do not|don't|use|time allowed|each question|all questions|candidates?|shade|choose the|this paper|calculators?|mobile phones?|instructions?|no\s|you (?:are|must|should|may))\b/i;
const LIST_INTRO = /:$|\b(?:following|statements?|consider|regarding|concerning|true about|which of)\b/i;
const TRUE_FALSE_MARK = /\(?\b(?:true\s*(?:or|\/)\s*false|t\s*\/\s*f)\b\)?[.:?]?/i;

function normalize(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function toLines(document: ExtractedDocument): Line[] {
  const lines: Line[] = [];
  for (const unit of document.units) {
    for (const block of unit.blocks) {
      for (const raw of block.text.split("\n")) {
        // "• " is what a list item in a Word document becomes.
        const text = raw.replace(/\s+/g, " ").trim().replace(/^•\s*/, "");
        if (!text || PAGE_MARK.test(text)) continue;
        lines.push({ text, page: unit.pageNumber ?? null, slide: unit.slideNumber ?? null, heading: block.kind === "heading" });
      }
    }
  }
  return lines;
}

function isHeading(line: Line) {
  if (line.heading || SECTION.test(line.text)) return true;
  const { text } = line;
  if (text.length > 80 || text.endsWith("?")) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  const upper = letters.filter((letter) => letter !== letter.toLowerCase()).length;
  return letters.length >= 8 && text.split(" ").length >= 2 && upper / letters.length >= 0.8;
}

// The single year a line names, or null if it names none or several.
function yearIn(text: string) {
  const years = new Set(text.match(YEAR) ?? []);
  return years.size === 1 ? Number([...years][0]) : null;
}

// "A. x B. y C. z" → three options, when the letters run in order from A.
function splitInlineOptions(text: string): Item[] | null {
  const marks = [...text.matchAll(INLINE_OPTION)];
  if (marks.length < 2 || marks[0].index !== 0) return null;
  const letters = marks.map((mark) => mark[1].toUpperCase());
  if (letters[0] !== "A" || !letters.every((letter, index) => letter.charCodeAt(0) === 65 + index)) return null;
  return marks.map((mark, index) => ({
    letter: letters[index],
    text: text.slice(mark.index + mark[0].length, marks[index + 1]?.index ?? text.length).trim(),
  }));
}

// The answers on a compact key line ("1. A  2. C  3. B"), or null if the
// line is anything else.
function compactKeyEntries(text: string): [string, string][] | null {
  const entries = [...text.matchAll(KEY_ENTRY)].map((match): [string, string] => [`${Number(match[1])}${(match[2] ?? "").toLowerCase()}`, match[3]]);
  if (entries.length === 0) return null;
  return text.replace(KEY_ENTRY, "").replace(/[\s,;|]+/g, "") === "" ? entries : null;
}

function parseTrueFalse(value: string): boolean | null {
  const word = normalize(value).split(" ")[0];
  if (word === "true" || word === "t") return true;
  if (word === "false" || word === "f") return false;
  return null;
}

// Turns what a paper says the answer is into the stored form, or null when
// it does not clearly name one.
function resolveAnswer(question: Pick<Entry, "type" | "options" | "choices">, value: string): string | boolean | null {
  const text = value.trim();
  if (question.type === "true_false") {
    const letter = question.choices ? /^\(?([A-Ba-b])\)?[.)]?$/.exec(text) : null;
    return parseTrueFalse(letter ? question.choices![letter[1].toUpperCase().charCodeAt(0) - 65] : text);
  }
  if (question.type === "multiple_choice") {
    const letter = /^\(?([A-Fa-f])\)?(?:[.):\-–]|\s|$)/.exec(text);
    if (letter) return question.options[letter[1].toUpperCase().charCodeAt(0) - 65] ?? null;
    return question.options.find((option) => normalize(option) === normalize(text)) ?? null;
  }
  if (question.type === "short_answer") return text.length >= 2 ? text.slice(0, PAST.maxQuestionChars) : null;
  return null;
}

function rawEntry(draft: Pick<Draft, "lines" | "page" | "slide" | "year">): Entry {
  return {
    number: null, label: null, instruction: false, type: "raw", options: [], correctAnswer: null, explanation: null,
    question: draft.lines.join("\n").slice(0, 8000), year: draft.year, page: draft.page, slide: draft.slide,
  };
}

// The questions one draft becomes: usually one, several for sub-questions,
// or a single raw entry when it does not hold together as a question.
function finish(draft: Draft): Entry[] {
  const stem = draft.stem.join(" ").trim();
  const label = draft.number === null ? null : `${draft.number}${draft.sub ?? ""}`;
  const base = { year: draft.year, page: draft.page, slide: draft.slide, explanation: draft.explanation.join(" ").trim().slice(0, 4000) || null };
  const build = (entry: Pick<Entry, "type" | "question" | "options" | "choices"> & { label: string | null; answer: string | null }): Entry => ({
    ...base,
    number: entry.label,
    label: entry.label,
    instruction: entry.type === "short_answer" && INSTRUCTION.test(entry.question),
    type: entry.type,
    question: entry.question,
    options: entry.options,
    ...(entry.choices ? { choices: entry.choices } : {}),
    correctAnswer: entry.answer === null ? null : resolveAnswer(entry, entry.answer),
  });

  const lettered = draft.items.length >= 2 && draft.items.every((item, index) => item.letter.charCodeAt(0) === 65 + index);
  let items = draft.items;
  let question = stem;
  // Lettered lines that do not run A, B, C… are part of the wording.
  if (items.length > 0 && !lettered) {
    question = [stem, ...items.map((item) => `${item.letter}. ${item.text}`)].join(" ").trim();
    items = [];
  }

  if (items.length > 0 && items.filter((item) => SUB_QUESTION.test(item.text)).length * 2 >= items.length) {
    // "(a) Define… (b) Explain…": each part is a question of its own.
    if (items.some((item) => !item.text) || draft.number === null) return [rawEntry(draft)];
    return items.map((item) =>
      build({ type: "short_answer", label: `${draft.number}${item.letter.toLowerCase()}`, options: [], answer: null, question: (question ? `${question}\n${item.text}` : item.text).slice(0, PAST.maxQuestionChars) }),
    );
  }

  if (question.length < 8 || question.length > PAST.maxQuestionChars) return [rawEntry(draft)];

  if (items.length > 0) {
    const options = items.map((item) => item.text.trim());
    const distinct = new Set(options.map(normalize)).size === options.length;
    if (options.length > PAST.maxOptions || options.some((option) => !option || option.length > PAST.maxOptionChars) || !distinct) return [rawEntry(draft)];
    const trueFalse = options.length === 2 && parseTrueFalse(options[0]) === true && parseTrueFalse(options[1]) === false;
    return [build(trueFalse ? { type: "true_false", label, question, options: [], choices: options, answer: draft.answer } : { type: "multiple_choice", label, question, options, answer: draft.answer })];
  }

  const type = TRUE_FALSE_MARK.test(question) || (draft.answer !== null && /^(?:true|false)\b/i.test(draft.answer.trim())) ? "true_false" : "short_answer";
  return [build({ type, label, question, options: [], answer: draft.answer })];
}

// Reads the answer key that starts at `start`, if there is one. `headed`
// keys ("ANSWERS") may also give written answers; a key with no heading is
// only believed when it is unmistakably one ("1. A" "2. C" "3. B" …).
function readKey(lines: Line[], start: number, headed: boolean) {
  const key = new Map<string, string>();
  let index = start;
  let last: string | null = null;
  let lettered = 0;

  for (; index < lines.length; index++) {
    const { text } = lines[index];
    const compact = compactKeyEntries(text);
    if (compact) {
      // The same number twice means a new set of questions has begun.
      if (compact.some(([label]) => key.has(label))) break;
      for (const [label, value] of compact) key.set(label, value);
      lettered += compact.length;
      last = null;
      continue;
    }
    if (!headed) break;

    const written = KEY_TEXT.exec(text);
    if (written) {
      const label = `${Number(written[1])}${(written[2] ?? "").toLowerCase()}`;
      if (key.has(label)) break;
      key.set(label, written[3]);
      last = label;
    } else if (last && !isHeading(lines[index]) && !KEY_HEADING.test(text)) {
      key.set(last, `${key.get(last)} ${text}`);
    } else if (SECTION.test(text) && key.size === 0) {
      continue;
    } else {
      break;
    }
  }

  // Under a heading, one "1. B" is a key. A single written line is not
  // enough to be sure, and without a heading it takes a clear run from 1.
  const enough = headed ? key.size >= 2 || lettered >= 1 : key.size >= 3 && key.has("1");
  return enough ? { key, next: index } : null;
}

export function parsePastQuestions(document: ExtractedDocument, options: ParseOptions = {}): ParseResult {
  const lines = toLines(document);
  const trustNumbers = options.trustNumbers ?? true;
  const entries: Entry[] = [];
  // Where the current run of numbering began, and where the questions an
  // answer key would apply to began.
  let sectionStart = 0;
  let keyStart = 0;
  let draft: Draft | null = null;
  let lastNumber: number | null = null;
  let year = options.year ?? null;

  const flush = () => {
    if (draft) entries.push(...finish(draft));
    draft = null;
  };

  // A numbered list of rules at the top of a paper ("1. Answer all
  // questions.") looks like questions. When a whole run is like that, it is
  // kept as raw text instead.
  const endSection = () => {
    flush();
    const section = entries.slice(sectionStart);
    if (section.length > 0 && section.length <= 12 && section.every((entry) => entry.instruction)) {
      entries.splice(sectionStart, section.length, {
        ...rawEntry({ lines: section.map((entry) => `${entry.number}. ${entry.question}`), page: section[0].page, slide: section[0].slide, year: section[0].year }),
      });
    }
    sectionStart = entries.length;
    lastNumber = null;
  };

  const applyKey = (key: Map<string, string>) => {
    const targets = entries.slice(keyStart).filter((entry) => entry.type !== "raw" && entry.label);
    const unique = new Set(targets.map((entry) => entry.label)).size === targets.length;
    // Repeated numbers make the match ambiguous: no answer is safer than a wrong one.
    if (trustNumbers && unique) {
      for (const entry of targets) {
        const value = key.get(entry.label!);
        if (value !== undefined && entry.correctAnswer === null) entry.correctAnswer = resolveAnswer(entry, value);
      }
    }
    keyStart = entries.length;
  };

  const open = (line: Line, number: number | null, sub: string | null, text: string) => {
    flush();
    draft = { number, sub, stem: [], items: [], answer: null, explanation: [], mode: "stem", inner: null, lines: [line.text], page: line.page, slide: line.slide, year };
    addStem(draft, text);
    if (number !== null) lastNumber = number;
  };

  // A question's first line may already hold its options.
  const addStem = (target: Draft, text: string) => {
    if (!text) return;
    const first = / \(?A[.)]\s+\S/.exec(text);
    const inline = first ? splitInlineOptions(text.slice(first.index + 1)) : null;
    if (inline) {
      target.stem.push(text.slice(0, first!.index).trim());
      target.items.push(...inline);
      target.mode = "options";
    } else {
      target.stem.push(text);
    }
  };

  const complete = (target: Draft) => target.items.length >= 2 || target.answer !== null || /[.?!]$/.test(target.stem.join(" ").trim());

  for (let index = 0; index < lines.length && entries.length < PAST.maxQuestionsPerSet; index++) {
    const line = lines[index];
    const { text } = line;
    const current = draft as Draft | null;

    // ---------------------------------------------------------- answer key
    const sameLine = INLINE_KEY.exec(text);
    const sameLineEntries = sameLine ? compactKeyEntries(sameLine[1]) : null;
    if (sameLineEntries && sameLineEntries.length >= 2) {
      // The key may carry on over the following lines.
      const rest = readKey(lines, index + 1, true);
      endSection();
      applyKey(new Map([...sameLineEntries, ...(rest?.key ?? [])]));
      index = (rest?.next ?? index + 1) - 1;
      continue;
    }
    const headedKey = KEY_HEADING.test(text) ? readKey(lines, index + 1, true) : null;
    const bareKey = !headedKey && (!current || complete(current)) && compactKeyEntries(text) ? readKey(lines, index, false) : null;
    const found = headedKey ?? bareKey;
    if (found) {
      endSection();
      applyKey(found.key);
      index = found.next - 1;
      continue;
    }

    // ------------------------------------------- answer and explanation
    if (current) {
      const answer = ANSWER.exec(text);
      if (answer) {
        current.answer = answer[1];
        current.mode = "answer";
        current.lines.push(text);
        continue;
      }
      const explanation = EXPLANATION.exec(text);
      if (explanation && (current.answer !== null || current.items.length > 0)) {
        if (explanation[1]) current.explanation.push(explanation[1]);
        current.mode = "explanation";
        current.lines.push(text);
        continue;
      }
    }

    // ------------------------------------------------- a new question?
    const start = QUESTION_START.exec(text);
    const label = start ? null : QUESTION_LABEL.exec(text);
    if (start || label) {
      const number = Number(start ? start[1] : (label![1] ?? label![2]));
      const sub = start ? (start[2] ?? start[3] ?? null)?.toLowerCase() ?? null : null;
      const rest = start ? start[4] : "";

      let accept: boolean;
      if (!current && lastNumber === null) {
        accept = true;
      } else if (current && current.inner !== null && number === current.inner && !sub) {
        // The next item of a list inside the question.
        current.inner++;
        accept = false;
      } else if (current && number === 1 && !sub && current.number !== null && current.items.length === 0 && current.answer === null && LIST_INTRO.test(current.stem.join(" ").trim())) {
        current.inner = 2;
        accept = false;
      } else if (lastNumber === null) {
        accept = true;
      } else if (sub && number === lastNumber) {
        accept = true;
      } else if (number > lastNumber && number - lastNumber <= PAST.maxNumberGap) {
        accept = true;
      } else if (number === 1) {
        // Numbering has started again: a new section or another paper.
        endSection();
        accept = true;
      } else {
        accept = false;
      }

      if (accept) {
        open(line, number, sub, rest);
        continue;
      }
    }

    // ------------------------------------------------------------ options
    if (current && (current.mode === "stem" || current.mode === "options")) {
      const inline = splitInlineOptions(text);
      const option = inline ? null : OPTION.exec(text);
      if (inline || option) {
        current.items.push(...(inline ?? [{ letter: option![1].toUpperCase(), text: option![2] ?? "" }]));
        current.mode = "options";
        current.inner = null;
        current.lines.push(text);
        continue;
      }
    }

    // ----------------------------------------------------------- headings
    if (isHeading(line) && (!current || complete(current))) {
      flush();
      year = yearIn(text) ?? year;
      continue;
    }
    if (!current) {
      // Before the first question: a title line may date the paper.
      if (lastNumber === null && text.length <= 100) year = yearIn(text) ?? year;
      continue;
    }

    // ------------------------------------------------------- continuation
    current.lines.push(text);
    if (current.mode === "explanation") current.explanation.push(text);
    else if (current.mode === "answer") current.answer = `${current.answer} ${text}`;
    else if (current.mode === "options") {
      const lastItem = current.items[current.items.length - 1];
      lastItem.text = `${lastItem.text} ${text}`.trim();
    } else current.stem.push(text);
  }
  endSection();

  const truncated = entries.length >= PAST.maxQuestionsPerSet;
  let questions: ParsedQuestion[] = entries.slice(0, PAST.maxQuestionsPerSet).map(toParsed);

  // Nothing recognisable: keep the paper's text as it is, in readable pieces.
  if (!questions.some((question) => question.type !== "raw")) {
    questions = [];
    let block: Line[] = [];
    const push = () => {
      if (block.length > 0 && questions.length < PAST.maxRawBlocks) {
        questions.push(rawEntryOf(block, options.year ?? null));
      }
      block = [];
    };
    for (const line of lines) {
      if (block.reduce((sum, item) => sum + item.text.length + 1, 0) + line.text.length > PAST.rawBlockChars) push();
      block.push(line);
    }
    push();
  }

  const structured = questions.filter((question) => question.type !== "raw");
  return {
    questions,
    structured: structured.length,
    raw: questions.length - structured.length,
    withAnswers: structured.filter((question) => question.correctAnswer !== null).length,
    truncated,
  };
}

// Drops what was only needed while reading.
function toParsed(entry: Entry): ParsedQuestion {
  const { number, type, question, options, correctAnswer, explanation, year, page, slide } = entry;
  return { number, type, question, options, correctAnswer, explanation, year, page, slide };
}

function rawEntryOf(block: Line[], year: number | null): ParsedQuestion {
  return toParsed(rawEntry({ lines: block.map((line) => line.text), page: block[0].page, slide: block[0].slide, year }));
}
