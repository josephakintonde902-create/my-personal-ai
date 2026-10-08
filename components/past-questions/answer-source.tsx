// Where a past question's answer came from, in words and with an icon.
// Never colour alone. Used wherever such an answer is shown, so the paper's
// own answers and Ari's are told apart the same way everywhere.
export function AnswerSourceLabel({ source }: { source: "official" | "ai_generated" }) {
  return source === "official" ? (
    <span className="answer-source is-official"><span aria-hidden="true">✓</span> From your paper&apos;s answer key</span>
  ) : (
    <span className="answer-source is-ai"><span aria-hidden="true">✧</span> Worked out by Ari — not from your paper</span>
  );
}
