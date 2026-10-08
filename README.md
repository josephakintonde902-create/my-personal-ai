# Ari — Your AI Study Tutor

Ari is a Next.js web application with a Progressive Web App foundation. Run it with `npm install`, then `npm run dev`.

## Authentication and profiles

Ari uses Supabase Auth with cookie-based sessions (`@supabase/ssr`).

### Setup

1. Copy `.env.example` to `.env.local` and fill in the project URL and publishable (or `anon`) key. The service-role key is never needed.
2. In the Supabase SQL Editor, run the files in `supabase/migrations/` in filename order. (With the Supabase CLI: `supabase link`, then `supabase db push`.)
3. In Supabase Dashboard → Authentication → URL Configuration, set **Site URL** to the app's URL and add `<app-url>/auth/callback` and `<app-url>/auth/confirm` to **Redirect URLs**. For local development that is `http://localhost:3000/auth/callback` and `http://localhost:3000/auth/confirm`.

### How it fits together

- `proxy.ts` refreshes the session on each request and redirects signed-out visitors away from protected routes (listed in `lib/auth/routes.ts`).
- `app/(app)/layout.tsx` re-checks the user against Supabase before rendering anything protected, and passes the user and profile to `AuthProvider`.
- `app/(auth)/actions.ts` holds every auth operation as a Server Action. `app/auth/callback` and `app/auth/confirm` complete links from emails.
- `public.profiles` has one row per user, created by a database trigger on sign-up. Row Level Security limits each user to their own row. Future user-owned tables should reference `profiles (id)` and use the same `auth.uid()` check.
- Profile photos go to the `avatars` storage bucket at `{user_id}/profile-image`; storage policies allow writes only inside the user's own folder.
- `supabase/tests/rls_profiles.sql` verifies the isolation between two accounts. Run it in the SQL Editor.

## Subjects and study materials

Students group uploads into subjects (`/subjects`, `/subjects/[id]`) and can see everything in one place at `/materials`.

- **Tables.** `public.subjects` and `public.study_materials`, both protected by Row Level Security and column-level grants. A composite foreign key guarantees a material and its subject have the same owner. Users can change a subject's name, description, color and icon, and a material's title; `user_id` and `processing_status` are never writable through the API.
- **Storage.** Files go to the private `study-materials` bucket at `{user_id}/{subject_id}/{material_id}/{safe_filename}`. There are no public URLs; downloads use signed links that expire after 60 seconds.
- **Upload flow.** The browser validates the file (extension, MIME type, size, leading bytes), uploads it straight to Storage, then calls the `registerMaterial` Server Action. That action rebuilds the path from the session, reads the real size and type back from Storage, and inserts the row. If the row can't be created the file is deleted.
- **Deleting.** Files are removed before rows, so a failure never leaves a file with nothing pointing at it. Deleting a subject also sweeps its folder for files that have no row.
- **Configuration.** Supported types, the 50 MB limit and the subject palette live in `lib/library/config.ts`. The bucket enforces the same size and type limits, so changing them needs a new migration as well.
- **Processing.** New materials are `pending`. Nothing reads or parses file contents yet; a later phase will advance `processing_status`.
- **Tests.** `supabase/tests/rls_library.sql` checks isolation between two accounts for subjects, materials and storage. Run it in the SQL Editor.

## Knowledge base

Uploaded materials are turned into searchable passages that the tutor uses to answer questions. Nothing in this part talks to a chat model.

```text
upload → claim → download → extract (→ OCR) → clean → chunk → embed → store → ready
```

- **Trigger.** `registerMaterial` schedules processing on the server with `after()`, so it continues after the upload response and does not depend on the browser. "Retry" and "Reprocess" in the material list call `processMaterialAction`. The list polls while anything is in progress.
- **Extraction** (`lib/ai/documents/`). PDF text per page (`unpdf`), DOCX headings, paragraphs, lists and tables (`mammoth`), PPTX slide titles, text, tables and speaker notes, legacy PPT (PowerPoint 97–2003) slide titles, text and speaker notes (`cfb`; password-protected files are rejected), and TXT with encoding detection. Only content is read; nothing in a file is executed.
- **OCR.** Images and scanned PDFs need OCR. `OcrProvider` in `lib/ai/documents/ocr.ts` is the interface; no provider is configured, so those files fail with a clear "not available yet" message instead of being marked ready.
- **Chunking** (`lib/ai/chunking/`). About 1,000 tokens per chunk with 150 tokens of overlap, breaking at headings and paragraphs. Each chunk keeps its page or slide number and section title. Settings are in `lib/ai/config.ts`.
- **Embeddings** (`lib/ai/embeddings/`). Behind the `EmbeddingProvider` interface. Two providers are included, OpenAI-compatible and Gemini (which has a free tier), chosen by `EMBEDDING_PROVIDER`; see Embeddings under the AI provider section. Requests are batched and retried. Set that provider's key; without it, uploads still work and materials stay `pending`.
- **Storage.** `public.document_chunks` with a pgvector `vector(1536)` column, in the app's own Supabase database. Both embedding providers return vectors of that size. Switching between them needs no migration, only reprocessing.
- **Runs.** Each processing attempt writes chunks under a run id. Search only sees the material's finished run, so reprocessing never shows half-written or duplicate chunks, and a failed reprocess keeps the previous ones.
- **Permissions.** Processing runs as the signed-in user; no service-role key is used. Status changes go through `start_`, `finish_` and `fail_material_processing`, which act only on the caller's own materials.
- **Search.** `searchKnowledgeBase({ query, subjectId?, materialId?, topK? })` in `lib/ai/retrieval/search.ts` embeds the question and calls `match_document_chunks`, which ranks in Postgres and takes the user from `auth.uid()`. Results include the material, subject, page or slide, and section. `POST /api/knowledge/search` exposes the same thing for manual checks.
- **Tests.** `npm test` runs the extraction, cleaning, chunking, pipeline, provider and retrieval tests. `supabase/tests/rls_rag.sql` checks chunk ownership and search isolation in the database.
- **Hosting note.** Processing needs the server to stay alive after the response (up to `maxDuration`, 300 seconds, on the pages that upload). If it is stopped midway, the material shows "Processing stopped" after 15 minutes and can be retried.

### Optional dashboard configuration

- **Email links that work across devices.** The default templates only complete in the browser that requested them. To lift that, edit the templates under Authentication → Emails so the link is `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` (Confirm sign up) and `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery` (Reset password).
- **Google sign-in.** Create an OAuth client in Google Cloud with the redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`, enter its ID and secret under Authentication → Sign In / Providers → Google, then set `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true`. The button stays hidden until then.
- **Custom SMTP.** Supabase's built-in email sender is limited to a few messages per hour and is meant for testing only.

## AI tutor

`/tutor` is where a student talks to Ari. Ari answers from the student's own materials where they help, from general knowledge where they don't, and keeps the two apart.

```text
question → authenticate → check ownership → save question → search materials → build context → chat model → stream answer → save answer
```

- **Setup.** Run the two `*_create_tutor_*` migrations, then choose an AI provider in `.env.local` (for example `AI_PROVIDER=gemini` and `GEMINI_API_KEY`; see `.env.example` and the AI provider section below). Without a key the page loads and explains that the tutor isn't set up. The tutor's chat model is configured separately from the embedding model.
- **Server only.** The browser talks to `POST /api/tutor/chat` and nothing else. The model is called from the server, so the key never reaches the client, and the tutor's instructions are not in the client bundle.
- **Request flow** (`lib/ai/tutor/handler.ts`). The user comes from the session, never from the request. The conversation and subject ids in the request are looked up as that user; one that belongs to someone else is reported as not found. The API route only wires in the real session, database, search and model.
- **Instructions** (`lib/ai/tutor/prompt.ts`). Who Ari is and how Ari teaches: adapt to the student, explain differently when something didn't land, correct misconceptions, check understanding without turning into a quiz, and no fixed answer template.
- **Study materials.** Each question is searched with the existing `searchKnowledgeBase()`; there is no second search system. With a subject selected the search is limited to it, otherwise it covers all of the student's materials. `TUTOR_TOP_K` passages (default 6) are given to the model, numbered, with their material, subject, page or slide and section. A search that fails doesn't stop the answer; Ari is told the notes couldn't be read.
- **Sources.** Ari cites passages by number. The UI shows a "From your materials" list containing only the passages an answer actually cited, with only the location details the knowledge base recorded.
- **Memory.** The most recent messages of the conversation (up to 16, within a size budget) are sent with each question. A short follow-up such as "explain that more simply" is searched together with the question before it. Limits are in `lib/ai/tutor/config.ts`.
- **Conversations.** `public.tutor_conversations` and `public.tutor_messages`, both protected by Row Level Security and column-level grants. A composite foreign key guarantees a message and its conversation have the same owner, and another that a conversation's subject does. Deleting a conversation removes its messages; deleting a subject keeps the conversation as "All materials".
- **Streaming.** The answer is streamed as one JSON event per line and saved when complete. If the browser disconnects, the answer is still finished and saved. "Try again" after a failure re-asks the saved question instead of sending it twice.
- **Limits.** 4,000 characters per message, 10 messages a minute and 300 a day per student, a capped answer length, and time limits on the model.
- **Provider.** `TutorModel` in `lib/ai/tutor/provider.ts` is the interface. Gemini, Grok, Claude and OpenAI-compatible APIs are supported; see the AI provider section below.
- **Rendering.** Answers are Markdown rendered with `react-markdown` and `remark-gfm` (tables, lists, code). Raw HTML and images in an answer are not rendered. There is no LaTeX renderer; Ari is told to write maths in plain text.
- **Tests.** `npm test` covers the request flow, isolation between users, validation, limits, the provider and the instructions (`tests/tutor.test.ts`). `supabase/tests/rls_tutor.sql` checks the database rules between two accounts. Run it in the SQL Editor.

## Quizzes and flashcards

`/quizzes` and `/flashcards` let a student practise what is in their own study materials. Ari writes the questions and cards from passages retrieved out of the knowledge base, never from a bare topic name.

```text
choose subject / material → check ownership → search materials → chat model → validate every item → save → practise
```

- **Setup.** Run the two `20261007170*` migrations. Nothing else: generation and marking use the same provider as the tutor (see the AI provider section below). There is no second AI integration.
- **Sources.** A quiz or deck can be made from all subjects, one subject, or one material. PDFs, PowerPoint (`.pptx` and `.ppt`), Word documents and text files are all the same thing here: passages in `document_chunks`, each with its page, slide or section. Only materials that show "Ready for Ari" are offered.
- **Retrieval** (`lib/ai/practice/sources.ts`). Through the existing `searchKnowledgeBase()`. With a "focus on" topic, the closest passages are used. Without one, passages are spread evenly across the material so a quiz on a lecture covers the whole lecture. `PRACTICE_MAX_CHUNKS` passages (default 12) are sent. If nothing is found, nothing is generated.
- **Prompts.** Three modules: `quiz-prompt.ts`, `flashcard-prompt.ts` and `evaluation-prompt.ts`.
- **Validation** (`lib/ai/practice/schema.ts`). Every question and card the model returns is checked on its own against a strict Zod schema, then against rules the schema can't express: four distinct options with one answer, no "all of the above", a correct option that isn't conspicuously the longest, no duplicates, and a cited passage that was really provided. Anything that fails is dropped and never stored. Rejected output is retried a limited number of times; a quiz that ends up with fewer than half the questions asked for is not saved.
- **Citations.** The model only says which numbered passage an item came from. The title, page, slide and section are then copied from the knowledge base, so they cannot be invented. Shown as "Lecture 4 — slide 18".
- **Taking a quiz.** One question at a time. The browser is sent questions without answers; each answer is checked on the server, which replies with whether it was right, the correct answer, the explanation and the source. Multiple choice options are shuffled when the quiz is created.
- **Short answers** are marked by the model on meaning (correct, partly correct, incorrect) against the model answer, the key points and the source passage. There is no string comparison. If the marking reply is unusable it is retried once, and otherwise the student is asked to try again; an answer is never accepted or rejected by guesswork.
- **Scores.** A correct answer scores 1 and a partly correct one 0.5. The score is worked out in the database by `complete_quiz_attempt()` from the stored answers; clients have no privilege to write it. The results page lists the topics missed in that attempt only.
- **Ask Ari to explain** opens `/tutor?explain=<answer id>`, which starts a conversation with the question, the student's answer, the correct answer, the explanation and the source already written, in the quiz's subject.
- **Quick practice** is a five-question mixed quiz with no setup, stored like any other quiz and marked "Practice".
- **Flashcards.** One card at a time: show the answer, then rate it Again, Hard, Good or Easy. Each rating is stored in `flashcard_reviews`. There is no scheduling yet; this is the data a spaced-repetition schedule will use.
- **Tables.** `quizzes`, `quiz_questions`, `quiz_attempts`, `quiz_answers`, `flashcard_decks`, `flashcards`, `flashcard_reviews`, all with Row Level Security and column-level grants. Composite foreign keys keep every row with a parent of the same owner, and an answer's question in the same quiz as its attempt. Questions and answers cannot be edited.
- **Limits.** Quizzes of 5, 10, 15 or 20 questions; decks of 10, 15, 20 or 30 cards; 12 generations an hour and 40 a day per student; a bounded number of model calls per generation. Limits are in `lib/ai/practice/config.ts`.
- **Tests.** `npm test` covers generation, validation, marking, scoring, isolation between users and PowerPoint sources (`tests/practice.test.ts`). `supabase/tests/rls_practice.sql` checks the database rules between two accounts. Run it in the SQL Editor.

## AI provider

Ari uses AI for two separate jobs, each chosen on its own. Changing one does not affect the other.

| Job | Chosen by | Providers |
|---|---|---|
| AI generation: tutor answers, quiz questions, flashcards, short-answer marking | `AI_PROVIDER` | `gemini`, `xai`, `anthropic`, `openai` |
| Embeddings: making study materials searchable | `EMBEDDING_PROVIDER` | `openai`, `gemini` |

Each generation provider reads only its own settings, so switching `AI_PROVIDER` never sends one provider's key to another:

| `AI_PROVIDER` | Key | Model (default) | Code |
|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` (`gemini-3.8-flash`) | `lib/ai/tutor/gemini-chat.ts`, official `@google/genai` SDK |
| `xai` | `XAI_API_KEY` | `XAI_MODEL` (`grok-4.7`) | `lib/ai/tutor/openai-chat.ts` against `https://api.x.ai/v1` |
| `anthropic` | `AI_API_KEY` | `AI_MODEL` (`claude-sonnet-5-5`) | `lib/ai/tutor/anthropic-chat.ts`, official `@anthropic-ai/sdk` |
| `openai` | `AI_API_KEY` | `AI_MODEL` (`gpt-4o-mini`), `AI_API_URL` | `lib/ai/tutor/openai-chat.ts` |

- **One interface.** `TutorModel` in `lib/ai/tutor/provider.ts` is all the tutor, quizzes, flashcards and marking know about. `getTutorModel()` returns the provider named by `AI_PROVIDER`; nothing else in the app refers to a provider. If `AI_PROVIDER` is not set, `anthropic` is used.
- **No automatic fallback.** One provider is in use at a time. If it fails, Ari reports the failure; it does not quietly switch to another. Grok is optional: nothing depends on an xAI key unless `AI_PROVIDER=xai`.
- **Each request is shaped for its provider.** The system prompt, the conversation, the answer-length limit and JSON mode (for quizzes, flashcards and marking) are translated into each API's own form. Answers are streamed from all four.
- **Mismatched settings are refused, not guessed at.** A key that belongs to a different provider than the one selected (for example an xAI key in `GEMINI_API_KEY`), or settings left over from another provider, are reported as "not set up" instead of being sent anywhere.
- **Errors.** A rejected key, an account with no credit, a rate limit or used-up free quota, a timeout, an outage and an unreadable reply each become an application error. Students see a plain message such as "Ari's AI service is temporarily unavailable"; the server log gets the status and the provider's error code, and never the key, the request or billing details.
- **Checking it.** `npm run ai:check` sends one short request through the same code and prints the provider, the model and what came back. Add `-- --embeddings` to test the embedding provider as well. It never prints a key.

### Embeddings

- **Providers** (`lib/ai/embeddings/`). `openai` (the default; any OpenAI-compatible embeddings API, `text-embedding-3-small`) and `gemini` (`gemini-embedding-001`, which has a free tier and uses `GEMINI_API_KEY`). With `EMBEDDING_PROVIDER=gemini` Ari needs no OpenAI credit at all.
- **Same vector size.** Both return 1536-dimension vectors, so the `vector(1536)` column is unchanged and no existing vector is touched.
- **Models are not interchangeable.** A question embedded by one model cannot be compared with passages embedded by another. Each chunk is tagged with the model that made it (`document_chunks.embedding_model`, added by `20261007180000_tag_chunk_embedding_model.sql`), and search only considers chunks from the model in use.
- **Switching provider** deletes nothing. Materials processed with the previous model stay stored but stop matching until "Reprocess" is pressed on them, which embeds them again with the current model.
- **Before that migration is applied** the app still works: chunks are stored and searched without the tag, exactly as before. The protection against mixing models starts once it is applied.
- **A material indexed with Gemini before that migration was applied** is tagged `text-embedding-3-small` by it (the migration assumes every earlier chunk was OpenAI's), so the search stops matching it although it still shows "Ready". The library marks such a material "Needs reprocessing"; Reprocess re-embeds it with the model in use. Until then, quizzes, flashcards and practice with no "Focus on" topic still work, because they read the material's passages in order rather than by similarity (`browseChunks` in `lib/ai/retrieval/index-health.ts`). A topic, and the tutor's search, need the reprocess.
- **Checking it.** In development, `GET /api/knowledge/health` (signed in) lists each ready material with how many passages are indexed, how many the search can reach, and which model they are tagged with. Add `?probe=1` to run one real search per material. It returns 404 in production.

## Performance

`/performance` answers "how well am I actually learning?" from the student's own records.

- **Nothing is stored.** There is no statistics table. Every figure is recalculated from `quiz_answers`, `quiz_questions`, `quiz_attempts`, `quizzes`, `subjects` and `flashcard_reviews` each time the page opens, so it cannot go stale.
- **No AI.** The calculations are arithmetic in `lib/performance/compute.ts` and work whether or not the AI provider is available.
- **Accuracy.** A correct answer counts 1 and a partly correct short answer a half, the same way a quiz is scored. Shown overall, by subject, by topic, by question type and by difficulty. Average quiz score is calculated separately, from completed quizzes.
- **Levels.** Strong at 80% or more, Developing from 60%, Needs review below that. A subject or topic gets a level only after at least 3 answers.
- **Weak areas.** A topic with at least 3 answers is flagged when its accuracy is below 60%, or when it is fine overall but its last 5 answers are below 60%.
- **Trend.** The most recent answers (up to 10) are compared with the same number before them. A change of 8 points or more is Improving or Declining, less is Stable, and with fewer than 4 answers in each group it says so instead of guessing.
- **Topics** come from the label each question was given when it was written. Answers to questions with no label are counted in the totals and reported as unlabelled, never assigned a topic.
- **Mistakes.** Accuracy by question type and difficulty, and the questions missed more than once. Nothing is inferred about why a mistake was made.
- **Flashcards** are shown as activity (cards reviewed and how they were rated), separately from quiz accuracy.
- **Thresholds** are all in `lib/performance/config.ts`.
- **Security.** Every read runs as the signed-in user under Row Level Security; there is no user parameter. `supabase/tests/rls_performance.sql` checks that one account cannot read the answers, attempts, questions or reviews another account's performance is calculated from.
- **Tests.** `tests/performance.test.ts` covers accuracy, levels, minimum evidence, weak areas, all four trend outcomes and the empty state.

## Past questions and exam mode

`/past-questions` holds a student's uploaded past papers; `/exam` turns them into timed, marked exam simulations.

```text
upload paper → extract text → read questions (no AI) → label topics (AI, once) → practise / sit an exam → readiness
```

- **Setup.** Run the two `20261008090*` migrations. No new environment variables. Reading a paper needs no AI model and no embedding provider; topic labelling uses the same provider as the tutor (`getTutorModel()`), and a paper stays usable if that provider is missing or fails.
- **Kept apart from study materials.** A paper's file goes in the same private `study-materials` bucket, under the same `{user}/{subject}/{id}/` layout, so the existing storage policies cover it. But it is a `past_question_sets` row, not a `study_materials` one: it is never chunked or embedded, never appears in the library, and the tutor or a generated quiz is never written from it. There is still one RAG system and one vector table, untouched.
- **Formats.** PDF, DOCX, PPTX, PPT and TXT, through the existing extractors (`lib/ai/documents`). Images are not accepted and a scanned PDF fails with a clear message, because there is no OCR provider (`lib/ai/documents/ocr.ts`).
- **Reading questions** (`lib/past-questions/parser.ts`) is deterministic. It recognises numbered questions (`1.`, `1)`, `Q1.`, `Question 1:`), lettered options on separate lines or one line, sub-questions (`1a.`, `1(b)`, `(a) … (b) …`), questions that run over a page, an answer after a question (`Answer: B`, with `Explanation:`), and an answer key after each paper or at the end. A numbered list inside a question and a paper's numbered instructions are not mistaken for questions. Word's automatic list numbers, which are not in a document's text, are put back first (`lib/past-questions/read.ts`).
- **When it cannot be sure it does less.** Text that does not hold together as a question (no stem, one option, two identical options, far too long) is stored word for word as a `raw` entry, shown on the collection page and never practised. A paper with no recognisable questions is kept as raw text. An answer key is ignored when question numbers repeat, or were reconstructed rather than printed, since a wrong match would present a wrong answer as official.
- **Answers are never invented.** A question has an `answer_source`: `official` (from the paper), `ai_generated` (worked out by Ari) or `answer_unavailable`. A database trigger stops an official answer being changed, or anything being relabelled official later. Ari's answers are labelled "Worked out by Ari — not from your paper" everywhere they appear, including in the message that opens "Ask Ari to explain".
- **Topics** (`lib/past-questions/analysis.ts`). One batched model call per 20 questions when a paper is first read, at most 12 calls per run; the result is stored, so no page load or count calls the model. The model is offered the student's existing topic names so one topic keeps one name. A label is kept only if the model said it was confident and it looks like a topic; otherwise `Uncategorized`. The same call may estimate difficulty, and suggest an answer where the paper gave none. "Analyse with Ari" on a collection continues where a run stopped.
- **Frequently tested** is plain counting of topics across the student's own uploads, worded as exactly that. It is not a prediction.
- **Practice reuses the quiz engine.** A session is a `quizzes` row (`mode = 'past_practice'`) whose `quiz_questions` are copies of the chosen past questions. It is then taken at `/quizzes/<id>` with the Phase 6 runner and services, unchanged: one question at a time, marked on the server, "Ask Ari to explain" included. Choices: all, random, by year, by topic, unanswered, previously missed, weak topics; 5, 10, 20, 30 or all.
- **Exam mode** (`mode = 'exam'`). One question at a time with a question map, a timer, mark-for-review, an unanswered indicator and a confirmation before submitting. The browser is sent questions only: no answers, explanations or topics until submission. Progress is saved to the server as the student goes, so a refresh loses nothing. Exams use multiple-choice and true/false questions, so the whole paper is marked without judgement the moment it is submitted.
- **Marking is done in the database.** `submit_exam_attempt()` receives the student's choices (an option's position, or true/false), compares each with the stored correct answer, writes the answers and the score, and closes the attempt in one transaction. There is no score, result or correct answer for a client to send. A restrictive RLS policy refuses any direct insert into an exam's answers, even by its owner. Submitting twice returns the first result.
- **The timer is the server's.** The clock starts when the attempt is created. `save_exam_progress()` refuses saves after the limit plus 30 seconds' grace, and a submission later than that is marked from the answers last saved in time. Time used is never more than time allowed. Limits: none, 15, 30, 45 or 60 minutes, or a custom 5–240.
- **Review.** Score, correct/incorrect/unanswered, time, a topic breakdown, question type and (only where questions carry an estimate) difficulty, then each question with the student's answer, the correct one, whose answer it was, and the explanation. "Retry incorrect questions" starts a practice session of exactly those.
- **Exam readiness** (`lib/performance/readiness.ts`, shown on `/performance` and the dashboard). A weighted average of five parts, each from the student's own records: recent exam scores (0.35), past-question accuracy (0.25), quiz accuracy (0.20), topic coverage (0.10) and consistency (0.10). A part with too little data is left out and the rest rescaled; topics needing review take up to 10 points off; no score before 10 answers. The formula is written out at the top of the file and every number is in `READINESS` in `lib/performance/config.ts`. The page shows each part and its share. It describes practice so far and never predicts a result.
- **Performance and weak areas** needed no changes to include past questions: their answers are `quiz_answers` like any others, so the existing topic, weak-area and trend calculations cover them.
- **Tables.** New: `past_question_sets`, `past_questions`. Extended: `quizzes` (two more modes, up to 200 questions, `past_question_set_id`), `quiz_questions` (`past_question_id`), `quiz_attempts` (`time_limit_seconds`, `time_used_seconds`, `exam_state`). The quiz tables were extended rather than duplicated because a session is exactly a quiz; every change widens a limit or adds a nullable column, so no existing row is touched. Questions are copied into a session, so a finished exam stays as it was sat even if its collection is deleted.
- **Limits.** 600 questions read per paper; sessions and exams of up to 200; the existing 40 attempts an hour. All in `lib/past-questions/config.ts`.
- **Tests.** `tests/past-questions.test.ts` (extraction, answer keys, processing, analysis, selection, practice, exam creation, marking, timer rules, forged requests, isolation) and `tests/readiness.test.ts` (the formula, thresholds, trend, recommendations, weak-topic integration). The model is scripted; nothing calls a paid API. `supabase/tests/rls_past_questions.sql` checks the database rules between two accounts. Run it in the SQL Editor.
- **Not built.** OCR; editing a collection's details after upload; written (short-answer) questions in exams, which are available in practice; storing the readiness figure with each exam.

## PWA foundation

- The App Router serves the web app manifest at `/manifest.webmanifest`; its standalone display mode and Ari icons support installation on supported browsers.
- `/sw.js` precaches the public manifest and app icons. It also keeps a copy of same-origin Next.js static assets, public icons, and the manifest, used only when the network cannot be reached: requests always go to the network first, so the app's code is never older than the page that asked for it.
- The service worker does not cache HTML navigations, API calls, Next.js data requests, cross-origin resources, uploaded files, or study content. This deliberately avoids persisting private or personalized data.
- Installation uses the browser's install prompt where available. On iOS Safari, the banner provides the Add to Home Screen steps. Dismissing the banner hides it for the current browser session.
- This foundation improves repeat asset loading and enables installation; the tutor and study materials are not available offline.

To test installation, run a production build with `npm run build` and `npm start`, then open Ari over localhost or HTTPS in a supported browser. The service worker is not registered in development by design.

## Production readiness

What to set, run and check before the app is put in front of students.

### Environment variables

Public (sent to the browser, safe by design):

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | The Supabase project's URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | The publishable (or legacy `anon`) key. Never the secret or `service_role` key. |
| `NEXT_PUBLIC_SITE_URL` | in production | The app's public URL, used in email links. Without it the links are built from the request's own address. |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | no | `true` shows "Continue with Google", once the provider is enabled in Supabase. |

Server only (never prefix with `NEXT_PUBLIC_`):

| Variable | Required | Purpose |
|---|---|---|
| `AI_PROVIDER` | yes | `gemini`, `xai`, `anthropic` or `openai`. Defaults to `anthropic` if unset. |
| `GEMINI_API_KEY` | with Gemini | Used for generation (`AI_PROVIDER=gemini`) and for embeddings (`EMBEDDING_PROVIDER=gemini`). |
| `GEMINI_MODEL`, `GEMINI_EMBEDDING_MODEL` | no | Override the default models. |
| `XAI_API_KEY`, `XAI_MODEL` | with `xai` | Grok. |
| `AI_API_KEY`, `AI_MODEL`, `AI_API_URL` | with `anthropic` / `openai` | Claude, or any OpenAI-compatible chat API. |
| `EMBEDDING_PROVIDER` | yes | `gemini` or `openai`. Defaults to `openai` if unset. |
| `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_API_URL` | with `openai` embeddings | Must return 1536-dimension vectors. |
| `AI_MAX_OUTPUT_TOKENS`, `TUTOR_TOP_K`, `PRACTICE_MAX_CHUNKS` | no | Tuning. |

`.env.example` lists the same variables with comments. The Supabase service-role key is not used anywhere and must not be added.

### Before going live

1. Apply every file in `supabase/migrations/` in filename order, then run each script in `supabase/tests/` in the SQL Editor with two signed-up accounts. Each ends with a `PASS` notice or raises the rule that failed.
2. Set `NEXT_PUBLIC_SITE_URL`, and add `<site>/auth/callback` and `<site>/auth/confirm` to Supabase's Redirect URLs.
3. Run `npm run ai:check -- --embeddings` with the production keys.
4. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`.

### What is enforced, and where

- **Identity** always comes from the verified session (`getCurrentUser()`); no route or action accepts a user id.
- **Ownership** is enforced by the database: Row Level Security on every table, column-level grants, and composite foreign keys that tie each row to a parent with the same owner. Changing an id in a URL or request finds nothing.
- **Files** are in a private bucket under `{user_id}/…`, reachable only through short-lived signed URLs. Profile photos are the one deliberate exception: a public bucket, written only by their owner.
- **AI keys** are read on the server only. Students never see provider errors, only a plain message; logs hold a status and a reason code, never a key or a prompt.
- **Requests** to the two API routes are limited to 64 KB (`lib/http/body.ts`) and refused before being parsed if larger. Server Actions are limited by Next.js. Tutor messages, quiz generation and attempts are rate-limited per student.
- **Response headers** (`next.config.ts`): `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` in production.

### Known gaps

- No Content-Security-Policy for pages yet (the service worker has one). Adding it needs testing against Supabase, Google Fonts and Next.js's inline scripts.
- No OCR: scanned PDFs and images are refused with a clear message.
- `/planner` is reserved in `lib/auth/routes.ts` but has no page; "Study history" in the sidebar is a placeholder.
- Rate limits are counted from the database per student; there is no IP-level limit in front of sign-in beyond Supabase's own.
