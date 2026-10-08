import { z } from "zod";
import { DIFFICULTIES, PRACTICE } from "./config";

// The exact shape the model must return. Nothing the model writes is trusted
// until it has passed one of these schemas; anything that does not pass is
// dropped and never stored.

const text = (max: number) => z.string().trim().min(1).max(max);

const shared = {
  question: text(600),
  explanation: text(1200),
  // A short label for what the question is about ("Accommodation").
  topic: text(80),
  difficulty: z.enum(DIFFICULTIES),
  // The number of the passage the question was written from.
  source: z.number().int().min(1),
};

export const generatedQuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("multiple_choice"),
    ...shared,
    options: z.array(text(300)).length(4),
    correctIndex: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    type: z.literal("true_false"),
    ...shared,
    correctAnswer: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("short_answer"),
    ...shared,
    expectedAnswer: text(600),
    acceptablePoints: z.array(text(200)).min(1).max(6),
  }),
]);

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export const generatedCardSchema = z.strictObject({
  front: text(400),
  back: text(900),
  difficulty: z.enum(DIFFICULTIES),
  source: z.number().int().min(1),
});

export type GeneratedCard = z.infer<typeof generatedCardSchema>;

export const evaluationSchema = z.strictObject({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: text(700),
});

// Finds the JSON in a model reply. Models sometimes wrap it in a code fence
// or add a sentence before it; anything that still fails to parse is
// reported as undefined rather than thrown.
export function parseModelJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// The list under `key` in a model reply ({ "questions": [...] }), or the
// reply itself if it is a bare list. Each entry is still unvalidated.
export function readItems(raw: string, key: string): unknown[] {
  const parsed = parseModelJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const items = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(items)) return items;
  }
  return [];
}

const STOP_WORDS = new Set(["the", "and", "for", "are", "was", "that", "this", "with", "from", "what", "which", "does", "who", "why", "how", "when", "into", "its", "can", "has", "have", "following", "true", "false", "statement"]);

function keywords(value: string) {
  const words = value.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

export function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// True when two questions (or two card fronts) say the same thing: identical
// once punctuation and case are ignored, or sharing most of their key words.
export function isDuplicate(a: string, b: string) {
  if (normalizeText(a) === normalizeText(b)) return true;
  const first = keywords(a);
  const second = keywords(b);
  if (first.size < 3 || second.size < 3) return false;

  let shared = 0;
  for (const word of first) if (second.has(word)) shared++;
  return shared / (first.size + second.size - shared) >= PRACTICE.duplicateSimilarity;
}
