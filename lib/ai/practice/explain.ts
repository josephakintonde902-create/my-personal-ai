import { sourceLabel } from "../tutor/citations";
import { TUTOR } from "../tutor/config";
import type { AnswerFeedback, PublicQuestion } from "./types";

// "Ask Ari to explain": turns one answered quiz question into the message
// that opens a tutor conversation about it, so the student does not have to
// type any of it again. The tutor then searches the student's materials for
// this message as it does for any other, which brings in the source passage.

export function answerText(value: string | boolean) {
  return typeof value === "boolean" ? (value ? "True" : "False") : value;
}

const OPENINGS = {
  incorrect: "I got this quiz question wrong. Can you explain it to me?",
  partial: "I only got this quiz question partly right. Can you explain what I missed?",
  correct: "I got this quiz question right, but I'd like to understand it better. Can you explain it?",
};

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function buildExplainMessage(question: Pick<PublicQuestion, "question" | "type" | "options">, feedback: AnswerFeedback) {
  const lines = [OPENINGS[feedback.result], "", `Question: ${clip(question.question, 700)}`];

  if (question.type === "multiple_choice") {
    lines.push(`Options: ${question.options.map((option, index) => `${String.fromCharCode(65 + index)}) ${clip(option, 200)}`).join("  ")}`);
  }
  lines.push(
    `My answer: ${feedback.answer === "" ? "(I didn't answer)" : clip(answerText(feedback.answer), 600)}`,
    // Ari is told when the "correct" answer is its own earlier suggestion
    // rather than the paper's, so it checks it instead of repeating it.
    feedback.answerSource === "ai_generated"
      ? `Suggested answer (worked out by Ari; my paper has no answer key, so please check it): ${clip(answerText(feedback.correctAnswer), 600)}`
      : `Correct answer${feedback.answerSource === "official" ? " (from my paper's answer key)" : ""}: ${clip(answerText(feedback.correctAnswer), 600)}`,
    `Explanation I was given: ${clip(feedback.explanation, 900)}`,
  );
  if (feedback.answerSource && feedback.topic) lines.push(`Topic: ${clip(feedback.topic, 80)}`);
  if (feedback.source) lines.push(`Source: ${sourceLabel(feedback.source)}`);

  return clip(lines.join("\n"), TUTOR.maxMessageLength);
}
