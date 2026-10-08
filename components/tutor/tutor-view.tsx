"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { deleteConversation } from "@/app/(app)/tutor/actions";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { citedSources, sourceLabel } from "@/lib/ai/tutor/citations";
import { TUTOR } from "@/lib/ai/tutor/config";
import type {
  TutorChatRequest,
  TutorConversation,
  TutorErrorBody,
  TutorMessage,
  TutorStreamEvent,
} from "@/lib/ai/tutor/types";
import type { SubjectOption } from "@/lib/library/types";
import { TutorMarkdown } from "./tutor-markdown";

type ViewMessage = TutorMessage & {
  // Stays the same while a message goes from "being sent" to "saved", so
  // React keeps the same element on screen.
  key: string;
  state?: "sending" | "streaming" | "failed";
};

type Failure = {
  message: string;
  // regenerate: the question is saved, ask for the answer again.
  // resend: the question never arrived, send it again.
  retry: "regenerate" | "resend" | null;
  text: string;
  signIn?: boolean;
};

type Props = {
  subjects: SubjectOption[];
  conversations: TutorConversation[];
  conversation: TutorConversation | null;
  messages: TutorMessage[];
  initialSubjectId: string | null;
  // A question to send as soon as the page opens, written for the student
  // (for example "Ask Ari to explain" on a quiz answer).
  autoAsk?: string | null;
  // False when no chat model is configured on the server.
  tutorEnabled: boolean;
  // True when the address named a conversation that could not be found.
  missing: boolean;
  // True when the conversation list could not be loaded.
  listFailed: boolean;
};

const SUGGESTIONS = [
  "What are the main ideas in my notes?",
  "Explain a topic I'm stuck on in simple terms",
  "Ask me one question to check my understanding",
];

const GENERIC_ERROR = "Something went wrong. Please try again.";
const CONNECTION_ERROR = "The connection dropped before Ari could finish. Check your internet and try again.";
const COUNTER_FROM = TUTOR.maxMessageLength - 500;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const listFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function conversationHref(id: string) {
  return `/tutor?c=${id}`;
}

function AriAvatar() {
  return <span aria-hidden="true" className="ari-mark tutor-avatar">a</span>;
}

export function TutorView(props: Props) {
  const { subjects, tutorEnabled, missing, listFailed } = props;
  const router = useRouter();
  const toast = useToast();

  const [conversations, setConversations] = useState(props.conversations);
  const [conversation, setConversation] = useState(props.conversation);
  const [messages, setMessages] = useState<ViewMessage[]>(() => props.messages.map((message) => ({ ...message, key: message.id })));
  const [subjectId, setSubjectId] = useState(props.conversation?.subjectId ?? props.initialSubjectId ?? "");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deleting, setDeleting] = useState<TutorConversation | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The conversation a request belongs to, readable from inside an answer
  // that is still streaming.
  const conversationId = useRef(props.conversation?.id ?? null);
  const localIds = useRef(0);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const closeDrawer = useRef<HTMLButtonElement>(null);
  // Follow new text to the bottom unless the student has scrolled up to read.
  const followBottom = useRef(true);

  const subjectNames = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
  const visibleConversations = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return term ? conversations.filter((item) => item.title.toLowerCase().includes(term)) : conversations;
  }, [conversations, filter]);

  useEffect(() => {
    const element = thread.current;
    if (element && followBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, failure]);

  // Grow the input with its text, up to the height limit set in CSS.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    if (!drawerOpen) return;
    // Move keyboard focus into the drawer that just opened.
    closeDrawer.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // Sends the prepared question once, shortly after the page opens. The
  // short delay means a mount that is immediately undone (as React does in
  // development) sends nothing.
  const sendPrepared = useEffectEvent(() => {
    if (props.autoAsk && tutorEnabled && messages.length === 0) void ask(props.autoAsk, false);
  });
  useEffect(() => {
    const timer = window.setTimeout(sendPrepared, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function adoptConversation(next: TutorConversation) {
    conversationId.current = next.id;
    setConversation(next);
    setConversations((list) => [next, ...list.filter((item) => item.id !== next.id)]);
    // Put the conversation in the address bar so a reload comes back to it.
    // This does not navigate: the chat on screen stays exactly as it is.
    const href = conversationHref(next.id);
    if (window.location.pathname + window.location.search !== href) window.history.replaceState(null, "", href);
  }

  function resetChat() {
    conversationId.current = null;
    setConversation(null);
    setMessages([]);
    setFailure(null);
    setSearchFailed(false);
    setDrawerOpen(false);
    followBottom.current = true;
  }

  function startNewChat() {
    if (busy) return;
    resetChat();
    router.push("/tutor");
    input.current?.focus();
  }

  async function ask(text: string, regenerate: boolean) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setSearchFailed(false);
    followBottom.current = true;

    const questionKey = `local-${++localIds.current}`;
    const answerKey = `local-${++localIds.current}`;
    const sentAt = new Date().toISOString();
    const update = (key: string, change: (message: ViewMessage) => ViewMessage) =>
      setMessages((list) => list.map((message) => (message.key === key ? change(message) : message)));
    const remove = (key: string) => setMessages((list) => list.filter((message) => message.key !== key));

    setMessages((list) => [
      // A question that never reached the server is replaced by this attempt.
      ...list.filter((message) => message.state !== "failed"),
      ...(regenerate ? [] : [{ key: questionKey, id: questionKey, role: "user" as const, content: text, sources: [], createdAt: sentAt, state: "sending" as const }]),
      { key: answerKey, id: answerKey, role: "assistant", content: "", sources: [], createdAt: sentAt, state: "streaming" },
    ]);

    // The question was saved by the server; only the answer is missing.
    const answerFailed = (message: string) => {
      remove(answerKey);
      setFailure({ message, retry: "regenerate", text });
    };
    // Nothing was saved.
    const requestFailed = (message: string, options: { retry?: boolean; signIn?: boolean } = {}) => {
      remove(answerKey);
      update(questionKey, (item) => ({ ...item, state: "failed" }));
      const retry = options.retry === false ? null : regenerate ? "regenerate" : "resend";
      setFailure({ message, retry, text, signIn: options.signIn });
    };

    let started = false;
    let settled = false;

    const handle = (event: TutorStreamEvent) => {
      if (event.type === "start") {
        started = true;
        adoptConversation(event.conversation);
        setSubjectId(event.conversation.subjectId ?? "");
        setSearchFailed(!event.searched);
        const saved = event.userMessage;
        if (saved) update(questionKey, (item) => ({ ...item, id: saved.id, createdAt: saved.createdAt, state: undefined }));
        update(answerKey, (item) => ({ ...item, sources: event.sources }));
      } else if (event.type === "delta") {
        update(answerKey, (item) => ({ ...item, content: item.content + event.text }));
      } else if (event.type === "done") {
        settled = true;
        update(answerKey, (item) => ({ ...item, id: event.message.id, createdAt: event.message.createdAt, state: undefined }));
      } else {
        settled = true;
        if (event.code === "ANSWER_NOT_SAVED") {
          // The answer is complete and on screen; it just was not stored.
          update(answerKey, (item) => ({ ...item, state: undefined }));
          setFailure({ message: event.message, retry: null, text });
        } else {
          answerFailed(event.message);
        }
      }
    };

    try {
      const body: TutorChatRequest = { conversationId: conversationId.current ?? undefined, subjectId: subjectId || null, regenerate };
      if (!regenerate) body.message = text;

      const response = await fetch("/api/tutor/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as TutorErrorBody | null;
        const message = data?.error ?? GENERIC_ERROR;
        settled = true;

        if (data?.code === "NOTHING_TO_RETRY" && conversationId.current) {
          // The answer arrived after all (for example the connection dropped
          // while it was being written). Load the saved conversation.
          window.location.assign(conversationHref(conversationId.current));
        } else if (data?.conversation) {
          adoptConversation(data.conversation);
          update(questionKey, (item) => ({ ...item, state: undefined }));
          answerFailed(message);
        } else if (response.status === 401) {
          requestFailed(message, { retry: false, signIn: true });
        } else {
          requestFailed(message, { retry: response.status !== 404 });
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handle(JSON.parse(line) as TutorStreamEvent);
        }
      }
      if (!settled) throw new Error("stream ended early");
    } catch {
      if (settled) return;
      if (started) answerFailed(CONNECTION_ERROR);
      else requestFailed(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !tutorEnabled || text.length > TUTOR.maxMessageLength) return;
    setDraft("");
    void ask(text, false);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line. Enter that confirms an input
    // method composition (for example Japanese or Chinese) is left alone.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function retry() {
    if (!failure?.retry) return;
    void ask(failure.text, failure.retry === "regenerate");
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    const result = await deleteConversation(deleting.id);
    setDeletePending(false);
    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }

    setConversations((list) => list.filter((item) => item.id !== deleting.id));
    if (conversationId.current === deleting.id) {
      resetChat();
      router.replace("/tutor");
    }
    toast("Conversation deleted.");
    setDeleting(null);
  }

  const tooLong = draft.length > TUTOR.maxMessageLength;
  const canSend = tutorEnabled && !busy && draft.trim().length > 0 && !tooLong;

  return (
    <div className={`tutor${drawerOpen ? " drawer-open" : ""}`}>
      <button aria-label="Close conversations" className="tutor-scrim" onClick={() => setDrawerOpen(false)} tabIndex={drawerOpen ? 0 : -1} type="button" />

      <aside aria-label="Conversations" className="tutor-panel" id="tutor-conversations">
        <div className="tutor-brand">
          <AriAvatar />
          <div><strong>Ari</strong><span>Your AI study tutor</span></div>
          <button aria-label="Close conversations" className="dialog-close tutor-panel-close" onClick={() => setDrawerOpen(false)} ref={closeDrawer} type="button">×</button>
        </div>

        <button className="action-button tutor-new" disabled={busy} onClick={startNewChat} type="button">
          <span aria-hidden="true">+</span> New chat
        </button>

        {conversations.length > 4 && (
          <input
            aria-label="Search conversations"
            className="field-input tutor-filter"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search chats"
            type="search"
            value={filter}
          />
        )}

        <nav aria-label="Previous conversations" className="tutor-list-wrap">
          {listFailed ? (
            <p className="tutor-list-empty">We couldn&apos;t load your conversations. Refresh the page to try again.</p>
          ) : conversations.length === 0 ? (
            <p className="tutor-list-empty">Your conversations with Ari will appear here.</p>
          ) : visibleConversations.length === 0 ? (
            <p className="tutor-list-empty">No chats match that search.</p>
          ) : (
            <ul className="tutor-list">
              {visibleConversations.map((item) => (
                <li className={item.id === conversation?.id ? "active" : undefined} key={item.id}>
                  <Link aria-current={item.id === conversation?.id ? "page" : undefined} href={conversationHref(item.id)} onClick={() => setDrawerOpen(false)}>
                    <strong>{item.title}</strong>
                    <span>
                      {item.subjectId && subjectNames.has(item.subjectId) ? subjectNames.get(item.subjectId) : "All materials"}
                      <i aria-hidden="true">·</i>
                      <time dateTime={item.updatedAt} suppressHydrationWarning>{listFormat.format(new Date(item.updatedAt))}</time>
                    </span>
                  </Link>
                  <button
                    aria-label={`Delete conversation: ${item.title}`}
                    className="tutor-delete"
                    disabled={busy && item.id === conversation?.id}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(item);
                    }}
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12" /></svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>

      <section aria-label="Chat with Ari" className="tutor-chat">
        <header className="tutor-header">
          <button
            aria-controls="tutor-conversations"
            aria-expanded={drawerOpen}
            aria-label="Show conversations"
            className="icon-button tutor-drawer-toggle"
            onClick={() => setDrawerOpen(true)}
            type="button"
          >
            <span aria-hidden="true">☰</span> Chats
          </button>
          <h1 className="tutor-title">{conversation?.title ?? "New chat"}</h1>
          <label className="tutor-subject">
            <span>Ask about</span>
            <select className="field-input" disabled={busy} onChange={(event) => setSubjectId(event.target.value)} value={subjectId}>
              <option value="">All materials</option>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
          </label>
          <button aria-label="New chat" className="icon-button tutor-new-compact" disabled={busy} onClick={startNewChat} type="button">
            <span aria-hidden="true">+</span>
          </button>
        </header>

        <div
          className="tutor-thread"
          onScroll={(event) => {
            const element = event.currentTarget;
            followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
          ref={thread}
        >
          <div className="tutor-thread-inner">
            {!tutorEnabled && (
              <div className="form-message info" role="status">
                Ari&apos;s tutor isn&apos;t set up yet. Once a chat model is configured on the server, you can ask questions here.
              </div>
            )}
            {missing && (
              <div className="form-message info" role="status">
                We couldn&apos;t find that conversation. It may have been deleted. You can start a new one below.
              </div>
            )}

            {messages.length === 0 ? (
              <div className="tutor-welcome">
                <span aria-hidden="true" className="ari-mark tutor-welcome-mark">a</span>
                <h2>What are we learning today?</h2>
                <p>
                  Ask me anything about what you&apos;re studying. I&apos;ll use your uploaded materials where they help, and explain things a different way if they don&apos;t click.
                </p>
                {subjects.length === 0 && (
                  <p className="tutor-welcome-note">
                    You haven&apos;t added any study materials yet. I can still explain things from general knowledge, or you can <Link href="/subjects">add a subject</Link> and upload your notes.
                  </p>
                )}
                <ul className="tutor-suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <li key={suggestion}>
                      <button
                        onClick={() => {
                          setDraft(suggestion);
                          input.current?.focus();
                        }}
                        type="button"
                      >
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              // aria-busy holds screen reader announcements until an answer
              // is complete, instead of reading it out word by word.
              <div aria-busy={busy} aria-label="Conversation" aria-live="polite" className="tutor-messages" role="log">
                {messages.map((message) => <MessageItem key={message.key} message={message} />)}
              </div>
            )}

            {searchFailed && (
              <p className="tutor-note" role="status">Ari couldn&apos;t search your materials for that question, so this answer uses general knowledge only.</p>
            )}

            {failure && (
              <div className="form-message error tutor-failure" role="alert">
                <span>{failure.message}</span>
                {failure.retry && <button className="icon-button" onClick={retry} type="button">Try again</button>}
                {failure.signIn && <Link className="icon-button" href="/login?next=/tutor">Sign in</Link>}
              </div>
            )}
          </div>
        </div>

        <form className="tutor-composer" onSubmit={submit}>
          <div className={`tutor-input${tooLong ? " has-error" : ""}`}>
            <label className="visually-hidden" htmlFor="tutor-message">Message Ari</label>
            <textarea
              aria-describedby="tutor-input-hint"
              disabled={!tutorEnabled}
              enterKeyHint="send"
              id="tutor-message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Ask Ari a question…"
              ref={input}
              rows={1}
              value={draft}
            />
            <button aria-busy={busy} aria-label={busy ? "Ari is answering" : "Send message"} className="tutor-send" disabled={!canSend} type="submit">
              {busy ? <span aria-hidden="true" className="spinner" /> : (
                <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
              )}
            </button>
          </div>
          <p className="tutor-hint" id="tutor-input-hint">
            {tooLong ? (
              <span className="field-error">That&apos;s {(draft.length - TUTOR.maxMessageLength).toLocaleString("en-GB")} characters over the limit.</span>
            ) : (
              <span>Enter to send · Shift + Enter for a new line. Ari can make mistakes, so check important facts.</span>
            )}
            {draft.length >= COUNTER_FROM && !tooLong && (
              <span aria-live="polite" className="field-count">{draft.length.toLocaleString("en-GB")} / {TUTOR.maxMessageLength.toLocaleString("en-GB")}</span>
            )}
          </p>
        </form>
      </section>

      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete conversation"
          error={deleteError}
          onClose={() => setDeleting(null)}
          onConfirm={confirmDelete}
          pending={deletePending}
          pendingLabel="Deleting…"
          title="Delete this conversation?"
        >
          <p>“{deleting.title}” and all of its messages will be permanently deleted.</p>
          <p>This can&apos;t be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function MessageItem({ message }: { message: ViewMessage }) {
  const time = (
    <time dateTime={message.createdAt} suppressHydrationWarning>{timeFormat.format(new Date(message.createdAt))}</time>
  );

  if (message.role === "user") {
    return (
      <article aria-label="You" className={`tutor-message from-user${message.state === "failed" ? " failed" : ""}`}>
        <div className="tutor-bubble">{message.content}</div>
        <p className="tutor-meta">{message.state === "failed" ? "Not sent" : message.state === "sending" ? "Sending…" : time}</p>
      </article>
    );
  }

  const thinking = message.state === "streaming" && !message.content;
  const cited = citedSources(message.content, message.sources);
  // The same page of the same document is listed once, with every number
  // that points at it.
  const references = new Map<string, number[]>();
  for (const source of cited) references.set(sourceLabel(source), [...(references.get(sourceLabel(source)) ?? []), source.n]);

  return (
    <article aria-label="Ari" className="tutor-message from-ari">
      <AriAvatar />
      <div className="tutor-answer">
        {thinking ? (
          <p className="tutor-thinking"><span className="visually-hidden">Ari is thinking…</span><i /><i /><i /></p>
        ) : (
          <TutorMarkdown content={message.content} sources={message.sources} />
        )}
        {references.size > 0 && (
          <div className="tutor-sources">
            <strong>From your materials</strong>
            <ul>
              {[...references].map(([label, numbers]) => (
                <li key={label}><span aria-hidden="true">{numbers.join(", ")}</span>{label}</li>
              ))}
            </ul>
          </div>
        )}
        {!message.state && <p className="tutor-meta">{time}</p>}
      </div>
    </article>
  );
}
