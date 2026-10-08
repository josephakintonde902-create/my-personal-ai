"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startPastPracticeAction } from "@/app/(app)/past-questions/actions";
import type { PastSelection } from "@/lib/past-questions/config";

type Props = {
  label: string;
  // Either the mistakes of one finished attempt...
  retryAttemptId?: string;
  // ...or a kind of question across everything uploaded.
  selection?: Extract<PastSelection, "missed" | "weak_topics" | "unanswered">;
  variant?: "primary" | "secondary";
};

// One press from a result to practising what went wrong: the questions are
// found on the server from the student's own answers, copied into a practice
// session, and opened in the quiz runner. Nothing has to be looked up by hand.
export function MistakePractice({ label, retryAttemptId, selection, variant = "secondary" }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await startPastPracticeAction(retryAttemptId ? { retryAttemptId } : { selection, count: 10 });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    // Stay locked until the quiz page has replaced this one.
    router.push(`/quizzes/${result.data.quizId}`);
  }

  return (
    <span className="mistake-practice">
      <button aria-busy={pending} className={variant === "primary" ? "auth-submit" : "auth-secondary"} disabled={pending} onClick={start} type="button">
        {pending && <span aria-hidden="true" className={`spinner${variant === "primary" ? "" : " dark"}`} />}
        {pending ? "Getting questions…" : label}
      </button>
      {error && <span className="field-error" role="alert">{error}</span>}
    </span>
  );
}
