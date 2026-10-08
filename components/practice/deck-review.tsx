"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { reviewCardAction } from "@/app/(app)/flashcards/actions";
import { useToast } from "@/components/ui/toast";
import { RATINGS } from "@/lib/ai/practice/config";
import type { Flashcard, FlashcardDeck, Rating } from "@/lib/ai/practice/types";
import { sourceLabel } from "@/lib/ai/tutor/citations";

type Props = { deck: FlashcardDeck; cards: Flashcard[]; subjectName: string | null };

const RATING_LABELS: Record<Rating, string> = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };
const RATING_HINTS: Record<Rating, string> = {
  again: "I didn't know it",
  hard: "I struggled",
  good: "I knew it",
  easy: "Too easy",
};

export function DeckReview({ deck, cards, subjectName }: Props) {
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // How each card was rated in this run through the deck.
  const [ratings, setRatings] = useState<Rating[]>([]);
  const cardButton = useRef<HTMLButtonElement>(null);
  const firstRating = useRef<HTMLButtonElement>(null);

  const card = cards[index];
  const done = index >= cards.length;

  function rate(rating: Rating) {
    if (!card || !revealed) return;
    // Saved in the background: the student moves on to the next card at
    // once, and is told if a rating could not be stored.
    void reviewCardAction(card.id, rating).then((result) => {
      if (!result.ok) toast(result.error, "error");
    });
    setRatings((list) => [...list, rating]);
    setRevealed(false);
    setIndex(index + 1);
  }

  function restart() {
    setIndex(0);
    setRevealed(false);
    setRatings([]);
  }

  // Keyboard: Space or Enter shows the answer (the card is a button), and
  // 1–4 rate it.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const rating = RATINGS[Number(event.key) - 1];
    if (revealed && rating) rate(rating);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Keep focus on the part of the card that just changed.
  useEffect(() => {
    if (revealed) firstRating.current?.focus();
    else cardButton.current?.focus({ preventScroll: true });
  }, [revealed, index]);

  if (cards.length === 0) {
    return (
      <div className="quiz-shell">
        <Link className="back-link" href="/flashcards">← Back to flashcards</Link>
        <div className="library-empty"><strong>This deck has no cards.</strong><p>Try creating it again from your study materials.</p></div>
      </div>
    );
  }

  return (
    <div className="quiz-shell">
      <Link className="back-link" href="/flashcards">← Back to flashcards</Link>

      <div className="quiz-progress">
        <span>{deck.title}{subjectName ? ` · ${subjectName}` : ""}</span>
        <div aria-hidden="true" className="progress-track"><span style={{ width: `${(Math.min(index, cards.length) / cards.length) * 100}%` }} /></div>
      </div>

      {done ? (
        <div className="quiz-panel quiz-result">
          <h1>Deck complete</h1>
          <p className="welcome-subtitle">You went through all {cards.length} cards. Your ratings are saved.</p>
          <ul className="deck-tally">
            {RATINGS.map((rating) => (
              <li className={`rate-${rating}`} key={rating}><strong>{ratings.filter((given) => given === rating).length}</strong><span>{RATING_LABELS[rating]}</span></li>
            ))}
          </ul>
          <div className="quiz-actions">
            <button className="auth-submit" onClick={restart} type="button">Review again</button>
            <Link className="auth-secondary" href="/flashcards">Back to flashcards</Link>
          </div>
        </div>
      ) : (
        <>
          <p className="quiz-count" role="status">Card {index + 1} of {cards.length}</p>

          {/* The whole card is one button, so it can be tapped anywhere. */}
          <button
            aria-expanded={revealed}
            className={`flashcard${revealed ? " is-revealed" : ""}`}
            disabled={revealed}
            onClick={() => setRevealed(true)}
            ref={cardButton}
            type="button"
          >
            <span className="flashcard-side">Question</span>
            <span className="flashcard-text">{card.front}</span>
            {!revealed && <span className="flashcard-hint">Show answer</span>}
          </button>

          {revealed && (
            <div aria-live="polite" className="flashcard flashcard-back">
              <span className="flashcard-side">Answer</span>
              <span className="flashcard-text">{card.back}</span>
              {card.source && <span className="quiz-source"><span>Source</span>{sourceLabel(card.source)}</span>}
            </div>
          )}

          {revealed ? (
            <div aria-label="How well did you know it?" className="rating-row" role="group">
              {RATINGS.map((rating, position) => (
                <button className={`rating-button rate-${rating}`} key={rating} onClick={() => rate(rating)} ref={position === 0 ? firstRating : undefined} type="button">
                  <strong>{RATING_LABELS[rating]}</strong>
                  <span>{RATING_HINTS[rating]}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="flashcard-keys">Tap the card, or press Space, to see the answer.</p>
          )}
        </>
      )}

      <details className="deck-all">
        <summary>All {cards.length} cards in this deck</summary>
        <ol>
          {cards.map((item) => (
            <li key={item.id}>
              <strong>{item.front}</strong>
              <span>{item.back}</span>
              {item.source && <em>{sourceLabel(item.source)}</em>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
