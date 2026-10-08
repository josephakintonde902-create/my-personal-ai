-- Performance check: the records the performance page is calculated from are
-- isolated between users.
--
-- The performance page stores nothing of its own. It reads quiz_answers,
-- quiz_questions, quiz_attempts, quizzes, subjects and flashcard_reviews as
-- the signed-in user and does arithmetic on them. So "user A cannot see user
-- B's performance" means: run as A, those reads return none of B's rows.
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up
-- and the Phase 6 migrations have been applied. It impersonates each user the
-- same way the API does, creates test rows, and raises an error on the first
-- rule that leaks. Everything is rolled back.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  subject_a uuid;
  subject_b uuid;
  quiz_a uuid;
  quiz_b uuid;
  q_a uuid;
  q_b1 uuid;
  q_b2 uuid;
  attempt_a uuid;
  attempt_b uuid;
  deck_b uuid;
  card_b uuid;
  a_answers_before int;
  a_attempts_before int;
  a_reviews_before int;
  n int;
  total numeric;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  -- What A already has, so the checks below work on accounts with real data.
  select count(*) into a_answers_before from public.quiz_answers where user_id = user_a;
  select count(*) into a_attempts_before from public.quiz_attempts where user_id = user_a;
  select count(*) into a_reviews_before from public.flashcard_reviews where user_id = user_a;

  -- ------------------------------------------------- user B does some work
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Performance test B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.quizzes (subject_id, title, difficulty, question_count, question_types)
  values (subject_b, 'B PRIVATE quiz', 'mixed', 2, array['true_false']) returning id into quiz_b;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation, metadata)
  values (quiz_b, 0, 'B PRIVATE question one', 'true_false', 'true'::jsonb, 'x', '{"topic":"B PRIVATE topic","difficulty":"hard"}'::jsonb) returning id into q_b1;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation, metadata)
  values (quiz_b, 1, 'B PRIVATE question two', 'true_false', 'false'::jsonb, 'x', '{"topic":"B PRIVATE topic","difficulty":"hard"}'::jsonb) returning id into q_b2;
  insert into public.quiz_attempts (quiz_id, total_questions) values (quiz_b, 2) returning id into attempt_b;
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
  values (attempt_b, q_b1, quiz_b, 'false'::jsonb, false, 'incorrect'), (attempt_b, q_b2, quiz_b, 'true'::jsonb, false, 'incorrect');
  perform public.complete_quiz_attempt(attempt_b);

  insert into public.flashcard_decks (subject_id, title) values (subject_b, 'B PRIVATE deck') returning id into deck_b;
  insert into public.flashcards (deck_id, position, front, back) values (deck_b, 0, 'B PRIVATE front', 'B PRIVATE back') returning id into card_b;
  insert into public.flashcard_reviews (flashcard_id, rating) values (card_b, 'again'), (card_b, 'hard');

  -- B can read their own performance records.
  select count(*) into n from public.quiz_answers where quiz_id = quiz_b;
  if n <> 2 then raise exception 'FAIL: user B cannot read their own answers'; end if;
  if (select score from public.quiz_attempts where id = attempt_b) is distinct from 0 then
    raise exception 'FAIL: user B''s score was not calculated';
  end if;

  -- ----------------------------------------------- user A does some work too
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Performance test A ' || gen_random_uuid()) returning id into subject_a;
  insert into public.quizzes (subject_id, title, difficulty, question_count, question_types)
  values (subject_a, 'A quiz', 'mixed', 1, array['true_false']) returning id into quiz_a;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation, metadata)
  values (quiz_a, 0, 'A question', 'true_false', 'true'::jsonb, 'x', '{"topic":"A topic","difficulty":"easy"}'::jsonb) returning id into q_a;
  insert into public.quiz_attempts (quiz_id, total_questions) values (quiz_a, 1) returning id into attempt_a;
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
  values (attempt_a, q_a, quiz_a, 'true'::jsonb, true, 'correct');
  perform public.complete_quiz_attempt(attempt_a);

  -- ---------------------------------- the performance page's reads, as user A
  -- Each is the query lib/performance/queries.ts runs, WITHOUT its user_id
  -- filter: Row Level Security alone must keep B's rows out.

  -- Answers: only A's.
  select count(*) into n from public.quiz_answers;
  if n <> a_answers_before + 1 then raise exception 'FAIL: user A sees % answers, expected %', n, a_answers_before + 1; end if;
  select count(*) into n from public.quiz_answers where quiz_id = quiz_b or attempt_id = attempt_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s answers'; end if;

  -- Attempts and scores: only A's.
  select count(*) into n from public.quiz_attempts;
  if n <> a_attempts_before + 1 then raise exception 'FAIL: user A sees % attempts, expected %', n, a_attempts_before + 1; end if;
  select count(*) into n from public.quiz_attempts where id = attempt_b or quiz_id = quiz_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s quiz attempts'; end if;

  -- Questions, their topics and difficulty: none of B's.
  select count(*) into n from public.quiz_questions
   where quiz_id = quiz_b or question like 'B PRIVATE%' or metadata ->> 'topic' like 'B PRIVATE%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s questions or topics'; end if;

  -- Quizzes and subjects: none of B's.
  select count(*) into n from public.quizzes where id = quiz_b or title like 'B PRIVATE%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s quizzes'; end if;
  select count(*) into n from public.subjects where id = subject_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s subjects'; end if;

  -- Flashcard reviews: only A's.
  select count(*) into n from public.flashcard_reviews;
  if n <> a_reviews_before then raise exception 'FAIL: user A sees % reviews, expected %', n, a_reviews_before; end if;
  select count(*) into n from public.flashcard_reviews where flashcard_id = card_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s flashcard reviews'; end if;
  select count(*) into n from public.flashcards where id = card_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s flashcards'; end if;

  -- Asking for B's rows by B's user id returns nothing either.
  select count(*) into n from public.quiz_answers where user_id = user_b;
  if n <> 0 then raise exception 'FAIL: filtering by user B''s id returned their answers'; end if;
  select count(*) into n from public.quiz_attempts where user_id = user_b;
  if n <> 0 then raise exception 'FAIL: filtering by user B''s id returned their attempts'; end if;
  select count(*) into n from public.flashcard_reviews where user_id = user_b;
  if n <> 0 then raise exception 'FAIL: filtering by user B''s id returned their reviews'; end if;

  -- So anything A adds up excludes B: B's two wrong answers do not lower it.
  select sum(case result when 'correct' then 1 when 'partial' then 0.5 else 0 end) into total
    from public.quiz_answers where quiz_id in (quiz_a, quiz_b);
  if total is distinct from 1 then raise exception 'FAIL: user B''s answers are counted in user A''s totals (%)', total; end if;

  -- A cannot change the records B's performance is calculated from.
  begin
    update public.quiz_answers set is_correct = true, result = 'correct' where quiz_id = quiz_b;
    raise exception 'FAIL: answers can be edited';
  exception when insufficient_privilege then null;
  end;
  delete from public.quizzes where id = quiz_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s quiz'; end if;

  -- ------------------------------------------------------- and the reverse
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.quiz_answers where quiz_id = quiz_a;
  if n <> 0 then raise exception 'FAIL: user B can read user A''s answers'; end if;
  select count(*) into n from public.quiz_attempts where id = attempt_a;
  if n <> 0 then raise exception 'FAIL: user B can read user A''s attempts'; end if;
  select count(*) into n from public.quiz_answers where quiz_id = quiz_b;
  if n <> 2 then raise exception 'FAIL: user B''s answers were changed (% left)', n; end if;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.quiz_answers;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read quiz answers'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.quiz_attempts;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read quiz attempts'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.flashcard_reviews;
    if n <> 0 then raise exception 'FAIL: signed-out visitors can read flashcard reviews'; end if;
  exception when insufficient_privilege then null;
  end;

  raise notice 'PASS: the records performance is calculated from are isolated between users.';
end;
$$;

rollback;
