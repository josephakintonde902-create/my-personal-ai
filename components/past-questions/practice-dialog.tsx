"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { startPastPracticeAction } from "@/app/(app)/past-questions/actions";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { PAST, type PastSelection } from "@/lib/past-questions/config";
import { matchingSummaries, summaryFacets } from "@/lib/past-questions/summary";
import type { PastQuestionSummary } from "@/lib/past-questions/types";

const SELECTIONS: { value: PastSelection; label: string; note: string }[] = [
  { value: "random", label: "Random questions", note: "A fresh mix each time." },
  { value: "all", label: "In the paper's order", note: "Work through from the first question." },
  { value: "unanswered", label: "Questions I haven't tried", note: "Only ones you have never answered." },
  { value: "missed", label: "Questions I got wrong", note: "Ones your last answer to was not correct." },
  { value: "weak_topics", label: "My weak topics", note: "Topics flagged “needs review” on your performance page." },
];

type Props = {
  // What the session draws from, for the title: a collection's name or "All past questions".
  scope: string;
  // Null means every collection.
  setIds: string[] | null;
  summaries: PastQuestionSummary[];
  initialSelection?: PastSelection;
  onClose: () => void;
};

// Sets up a practice session from past questions. The session itself is an
// ordinary quiz, opened in the quiz runner.
export function PracticeDialog({ scope, setIds, summaries, initialSelection = "random", onClose }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [selection, setSelection] = useState<PastSelection>(initialSelection);
  const [year, setYear] = useState("");
  const [topic, setTopic] = useState("");
  const [count, setCount] = useState<number | "all">(10);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inScope = setIds ? summaries.filter((question) => setIds.includes(question.setId)) : summaries;
  const { years, topics } = summaryFacets(inScope.filter((question) => question.answerable));
  const matching = matchingSummaries(inScope, { kind: "practice", setIds: null, year: year ? Number(year) : null, topic: topic || null, difficulty: null, selection }).length;
  // Which topics are weak is worked out on the server when the session starts.
  const approximate = selection === "weak_topics";

  async function start(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await startPastPracticeAction({ setIds: setIds ?? [], selection, year: year || null, topic: topic || null, count });
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    if (result.data.requested !== null && result.data.delivered < result.data.requested) {
      toast(`Only ${result.data.delivered} ${result.data.delivered === 1 ? "question matches" : "questions match"}, so that's what this session has.`);
    }
    // Stay locked until the quiz page has replaced this one.
    router.push(`/quizzes/${result.data.quizId}`);
  }

  return (
    <Dialog busy={pending} description={scope} onClose={onClose} title="Practise past questions">
      <form className="auth-form" onSubmit={start}>
        <div className="field">
          <label htmlFor="practice-selection">Which questions</label>
          <select className="field-input" disabled={pending} id="practice-selection" onChange={(event) => setSelection(event.target.value as PastSelection)} value={selection}>
            {SELECTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="field-hint">{SELECTIONS.find((option) => option.value === selection)!.note}</span>
        </div>

        <div className="practice-row">
          <div className="field">
            <label htmlFor="practice-year">Year</label>
            <select className="field-input" disabled={pending || years.length === 0} id="practice-year" onChange={(event) => setYear(event.target.value)} value={year}>
              <option value="">{years.length === 0 ? "No years recorded" : "All years"}</option>
              {years.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="practice-count">Questions</label>
            <select className="field-input" disabled={pending} id="practice-count" onChange={(event) => setCount(event.target.value === "all" ? "all" : Number(event.target.value))} value={count}>
              {PAST.practiceSizes.map((size) => <option key={size} value={size}>{size}</option>)}
              <option value="all">All available</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="practice-topic">Topic</label>
          <select className="field-input" disabled={pending || topics.length === 0} id="practice-topic" onChange={(event) => setTopic(event.target.value)} value={topic}>
            <option value="">All topics</option>
            {topics.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>

        <p className="practice-wait" role="status">
          {approximate ? "Ari will pick questions from your weak topics." : matching === 0 ? "No questions match these choices." : `${matching} ${matching === 1 ? "question matches" : "questions match"}.`}
        </p>
        {error && <div className="form-message error" role="alert">{error}</div>}

        <div className="dialog-actions">
          <button className="auth-secondary" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <button aria-busy={pending} className="auth-submit" disabled={pending || (!approximate && matching === 0)} type="submit">
            {pending && <span aria-hidden="true" className="spinner" />}
            {pending ? "Getting questions…" : "Start practice"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
