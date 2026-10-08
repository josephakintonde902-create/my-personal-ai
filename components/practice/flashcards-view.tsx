"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { deleteDeckAction, generateDeckAction } from "@/app/(app)/flashcards/actions";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { PRACTICE } from "@/lib/ai/practice/config";
import type { DeckListItem } from "@/lib/ai/practice/queries";
import { formatDate } from "@/lib/library/format";
import type { SubjectOption } from "@/lib/library/types";
import { EMPTY_SCOPE, ScopeFields, type MaterialOption, type Scope } from "./scope-fields";

type Props = {
  subjects: SubjectOption[];
  materials: MaterialOption[];
  decks: DeckListItem[];
  // False when no chat model is configured on the server.
  enabled: boolean;
  // True when the deck list could not be loaded.
  listFailed: boolean;
};

export function FlashcardsView({ subjects, materials, enabled, listFailed, ...props }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [decks, setDecks] = useState(props.decks);
  const [scope, setScope] = useState<Scope>(EMPTY_SCOPE);
  const [count, setCount] = useState(20);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeckListItem | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const subjectNames = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const canGenerate = enabled && materials.length > 0 && !generating;

  async function createDeck(event: FormEvent) {
    event.preventDefault();
    // A second click while Ari is writing must not start a second deck.
    if (generating) return;
    setGenerating(true);
    setError(null);

    const result = await generateDeckAction({ subjectId: scope.subjectId || null, materialId: scope.materialId || null, topic: scope.topic, count });
    if (!result.ok) {
      setError(result.error);
      setGenerating(false);
      return;
    }
    if (result.data.delivered < result.data.requested) {
      toast(`Ari wrote ${result.data.delivered} good cards from this material instead of ${result.data.requested}.`);
    }
    // Stay locked until the deck page has replaced this one.
    router.push(`/flashcards/${result.data.deckId}`);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    const result = await deleteDeckAction(deleting.id);
    setDeletePending(false);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }
    setDecks((list) => list.filter((deck) => deck.id !== deleting.id));
    toast("Deck deleted.");
    setDeleting(null);
  }

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> REMEMBER WHAT MATTERS</p>
          <h1>Flashcards<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Ari turns your study materials into cards you can review a few minutes at a time.</p>
        </div>
      </div>

      {!enabled && (
        <div className="form-message info" role="status">Ari isn&apos;t set up to create flashcards yet. Once a chat model is configured on the server, you can make a deck here.</div>
      )}
      {enabled && materials.length === 0 && (
        <div className="form-message info" role="status">
          Flashcards are written from your study materials, and none are ready yet. <Link className="link-button" href="/materials">Upload a PDF, PowerPoint, Word document or text file</Link>, then come back once it shows “Ready for Ari”.
        </div>
      )}

      <div className="practice-grid single">
        <form aria-labelledby="deck-form-title" className="practice-card" onSubmit={createDeck}>
          <h2 id="deck-form-title">Create a deck</h2>
          <p className="practice-card-note">Choose what the cards should cover.</p>

          <div className="practice-row wide">
            <ScopeFields disabled={!canGenerate} idPrefix="deck" materials={materials} onChange={setScope} subjects={subjects} topicMaxLength={PRACTICE.maxTopicLength} value={scope} />
            <div className="field">
              <label htmlFor="deck-count">Cards</label>
              <select className="field-input" disabled={!canGenerate} id="deck-count" onChange={(event) => setCount(Number(event.target.value))} value={count}>
                {PRACTICE.deckSizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
          </div>

          {error && <div className="form-message error" role="alert">{error}</div>}
          <button aria-busy={generating} className="auth-submit" disabled={!canGenerate} type="submit">
            {generating && <span aria-hidden="true" className="spinner" />}
            {generating ? "Writing your cards…" : "Create deck"}
          </button>
          {generating && <p className="practice-wait" role="status">Ari is reading your material and writing cards. This can take up to a minute.</p>}
        </form>
      </div>

      <section aria-labelledby="deck-list-title" className="lower-section">
        <div className="section-heading lower-heading">
          <div><span aria-hidden="true" className="section-icon library-icon">▤</span><h2 id="deck-list-title">Your decks</h2></div>
        </div>

        {listFailed ? (
          <div className="form-message error" role="alert">We couldn&apos;t load your decks just now. Refresh the page to try again.</div>
        ) : decks.length === 0 ? (
          <div className="library-empty compact">
            <strong>No decks yet.</strong>
            <p>The decks you create will be listed here, most recently studied first.</p>
          </div>
        ) : (
          <ul className="practice-list">
            {decks.map((deck) => (
              <li className="practice-item" key={deck.id}>
                <Link className="practice-item-link" href={`/flashcards/${deck.id}`}>
                  <span className="practice-item-copy">
                    <strong>{deck.title}</strong>
                    <span>
                      {deck.subjectId && subjectNames.has(deck.subjectId) ? subjectNames.get(deck.subjectId) : "All subjects"}
                      <i aria-hidden="true">·</i>{deck.cards} {deck.cards === 1 ? "card" : "cards"}
                      <i aria-hidden="true">·</i>Created {formatDate(deck.createdAt)}
                    </span>
                  </span>
                  <span className="status-badge status-ready">Start review</span>
                </Link>
                <button
                  aria-label={`Delete deck: ${deck.title}`}
                  className="icon-button danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(deck);
                  }}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete deck"
          error={deleteError}
          onClose={() => setDeleting(null)}
          onConfirm={confirmDelete}
          pending={deletePending}
          pendingLabel="Deleting…"
          title="Delete this deck?"
        >
          <p>“{deleting.title}”, its {deleting.cards} cards and your review history for them will be permanently deleted.</p>
          <p>This can&apos;t be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
