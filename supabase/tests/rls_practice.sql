-- Practice check: quizzes, attempts, answers, flashcard decks, cards and
-- reviews are isolated between users, and scores cannot be written directly.
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
  material_b uuid := gen_random_uuid();
  quiz_a uuid;
  quiz_a2 uuid;
  quiz_b uuid;
  q_a1 uuid;
  q_a2 uuid;
  q_a3 uuid;
  q_other uuid;
  q_b uuid;
  attempt_a uuid;
  attempt_b uuid;
  answer_b uuid;
  deck_a uuid;
  deck_b uuid;
  card_a uuid;
  card_b uuid;
  result public.quiz_attempts;
  before_update timestamptz;
  n int;
  t text;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  foreach t in array array['quizzes', 'quiz_questions', 'quiz_attempts', 'quiz_answers', 'flashcard_decks', 'flashcards', 'flashcard_reviews'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: RLS is not enabled on public.%', t;
    end if;
  end loop;

  -- ------------------------------------------------------------------ user B
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Practice test B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.study_materials (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (material_b, subject_b, 'B private slides', 'b.pptx', user_b || '/' || subject_b || '/' || material_b || '/b.pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation', 10, 'pptx');

  insert into public.quizzes (subject_id, material_id, title, difficulty, question_count, question_types)
  values (subject_b, material_b, 'B private quiz', 'mixed', 1, array['true_false']) returning id into quiz_b;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation)
  values (quiz_b, 0, 'B SECRET question', 'true_false', 'true'::jsonb, 'B SECRET explanation') returning id into q_b;
  insert into public.quiz_attempts (quiz_id, total_questions) values (quiz_b, 1) returning id into attempt_b;
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
  values (attempt_b, q_b, quiz_b, 'true'::jsonb, true, 'correct') returning id into answer_b;

  insert into public.flashcard_decks (subject_id, title) values (subject_b, 'B private deck') returning id into deck_b;
  insert into public.flashcards (deck_id, position, front, back, source)
  values (deck_b, 0, 'B SECRET front', 'B SECRET back', '{"n":1,"title":"B private slides","slide":3}'::jsonb) returning id into card_b;
  insert into public.flashcard_reviews (flashcard_id, rating) values (card_b, 'good');

  -- ------------------------------------------------------------------ user A
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Practice test A ' || gen_random_uuid()) returning id into subject_a;

  -- A can create a quiz with questions, and read them back.
  insert into public.quizzes (subject_id, title, difficulty, question_count, question_types)
  values (subject_a, 'A optics quiz', 'medium', 3, array['multiple_choice', 'true_false', 'short_answer']) returning id into quiz_a;
  insert into public.quiz_questions (quiz_id, position, question, question_type, options, correct_answer, explanation, sources)
  values (quiz_a, 0, 'Which structure refracts most?', 'multiple_choice', '["Cornea","Lens","Retina","Iris"]'::jsonb, '"Cornea"'::jsonb, 'The cornea.',
          '[{"n":1,"title":"Optics lecture","subject":"Optics","page":null,"slide":4,"section":null}]'::jsonb)
  returning id into q_a1;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation)
  values (quiz_a, 1, 'The lens flattens for near vision.', 'true_false', 'false'::jsonb, 'It becomes more convex.') returning id into q_a2;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation)
  values (quiz_a, 2, 'Describe accommodation.', 'short_answer', '"The lens becomes more convex."'::jsonb, 'Ciliary muscle contracts.') returning id into q_a3;

  if (select user_id from public.quizzes where id = quiz_a) is distinct from user_a then
    raise exception 'FAIL: a new quiz is not owned by the user who created it';
  end if;
  select count(*) into n from public.quiz_questions where quiz_id = quiz_a;
  if n <> 3 then raise exception 'FAIL: user A cannot read their own questions'; end if;
  if (select (sources -> 0 ->> 'slide')::int from public.quiz_questions where id = q_a1) <> 4 then
    raise exception 'FAIL: a question''s slide reference was not stored';
  end if;

  -- A second quiz, to check that answers cannot cross between quizzes.
  insert into public.quizzes (title, difficulty, question_count, question_types)
  values ('A other quiz', 'easy', 1, array['true_false']) returning id into quiz_a2;
  insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation)
  values (quiz_a2, 0, 'Other', 'true_false', 'true'::jsonb, 'x') returning id into q_other;

  -- ------------------------------------------------- taking the quiz as A
  insert into public.quiz_attempts (quiz_id, total_questions) values (quiz_a, 3) returning id into attempt_a;
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
  values (attempt_a, q_a1, quiz_a, '"Cornea"'::jsonb, true, 'correct');
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result, evaluation)
  values (attempt_a, q_a3, quiz_a, '"the lens gets rounder"'::jsonb, false, 'partial', '{"feedback":"Half right."}'::jsonb);

  -- One answer per question per attempt.
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_a, q_a1, quiz_a, '"Lens"'::jsonb, false, 'incorrect');
    raise exception 'FAIL: a question was answered twice in one attempt';
  exception when unique_violation then null;
  end;

  -- A question from another quiz cannot be answered in this attempt.
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_a, q_other, quiz_a, 'true'::jsonb, true, 'correct');
    raise exception 'FAIL: an answer was accepted for a question from a different quiz';
  exception when foreign_key_violation then null;
  end;

  -- is_correct must agree with the result.
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_a, q_a2, quiz_a, 'true'::jsonb, true, 'incorrect');
    raise exception 'FAIL: an answer was stored as both correct and incorrect';
  exception when check_violation then null;
  end;

  -- The score cannot be written directly.
  begin
    update public.quiz_attempts set score = 3, completed_at = now() where id = attempt_a;
    raise exception 'FAIL: a user can write their own score';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.quiz_attempts (quiz_id, total_questions, score) values (quiz_a, 3, 3);
    raise exception 'FAIL: an attempt can be created with a score';
  exception when insufficient_privilege then null;
  end;

  -- Completing works out the score: 1 correct + 1 partial + 1 unanswered = 1.5 of 3.
  result := public.complete_quiz_attempt(attempt_a);
  if result.score is distinct from 1.5 or result.total_questions <> 3 or result.completed_at is null then
    raise exception 'FAIL: completing gave score %, total % (expected 1.5 of 3)', result.score, result.total_questions;
  end if;

  -- Completing again changes nothing, and a finished attempt takes no more answers.
  if (public.complete_quiz_attempt(attempt_a)).completed_at is distinct from result.completed_at then
    raise exception 'FAIL: completing twice changed the attempt';
  end if;
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_a, q_a2, quiz_a, 'false'::jsonb, true, 'correct');
    raise exception 'FAIL: a finished attempt accepted another answer';
  exception when insufficient_privilege then null;
  end;

  -- Questions and answers are final.
  begin
    update public.quiz_questions set correct_answer = '"Lens"'::jsonb where id = q_a1;
    raise exception 'FAIL: questions can be edited';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.quiz_answers set is_correct = true, result = 'correct' where attempt_id = attempt_a;
    raise exception 'FAIL: answers can be edited';
  exception when insufficient_privilege then null;
  end;

  -- --------------------------------------------- A cannot see B's quiz data
  select count(*) into n from public.quizzes where id = quiz_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s quiz'; end if;
  select count(*) into n from public.quiz_questions where quiz_id = quiz_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s questions'; end if;
  select count(*) into n from public.quiz_questions where question like 'B SECRET%' or explanation like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user B''s questions are visible to user A'; end if;
  select count(*) into n from public.quiz_attempts where id = attempt_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s attempt'; end if;
  select count(*) into n from public.quiz_answers where id = answer_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s answers'; end if;

  -- ------------------------------------------ A cannot write into B's quiz
  begin
    insert into public.quiz_attempts (quiz_id, total_questions) values (quiz_b, 1);
    raise exception 'FAIL: user A started an attempt at user B''s quiz';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_b, q_b, quiz_b, 'false'::jsonb, false, 'incorrect');
    raise exception 'FAIL: user A submitted an answer to user B''s attempt';
  exception when insufficient_privilege or foreign_key_violation or unique_violation then null;
  end;
  begin
    insert into public.quiz_questions (quiz_id, position, question, question_type, correct_answer, explanation)
    values (quiz_b, 5, 'intruder', 'true_false', 'true'::jsonb, 'x');
    raise exception 'FAIL: user A added a question to user B''s quiz';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.quizzes (user_id, title, difficulty, question_count, question_types) values (user_b, 'forged', 'easy', 1, array['true_false']);
    raise exception 'FAIL: user A created a quiz owned by user B';
  exception when insufficient_privilege then null;
  end;
  -- A quiz cannot be linked to another user's subject or material.
  begin
    insert into public.quizzes (subject_id, title, difficulty, question_count, question_types) values (subject_b, 'borrowed', 'easy', 1, array['true_false']);
    raise exception 'FAIL: user A created a quiz on user B''s subject';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.quizzes (material_id, title, difficulty, question_count, question_types) values (material_b, 'borrowed', 'easy', 1, array['true_false']);
    raise exception 'FAIL: user A created a quiz on user B''s material';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  if (public.complete_quiz_attempt(attempt_b)).id is not null then
    raise exception 'FAIL: user A could complete user B''s attempt';
  end if;
  delete from public.quizzes where id = quiz_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s quiz'; end if;

  -- ------------------------------------------------------------- flashcards
  insert into public.flashcard_decks (subject_id, title) values (subject_a, 'A optics deck') returning id into deck_a;
  insert into public.flashcards (deck_id, position, front, back, source, difficulty)
  values (deck_a, 0, 'What bends light most?', 'The cornea.', '{"n":1,"title":"Optics lecture","subject":"Optics","page":null,"slide":4,"section":null}'::jsonb, 'easy')
  returning id into card_a;

  if (select user_id from public.flashcards where id = card_a) is distinct from user_a then
    raise exception 'FAIL: a new card is not owned by the user who created it';
  end if;
  if (select deck_id from public.flashcards where id = card_a) is distinct from deck_a then
    raise exception 'FAIL: a card is not linked to its deck';
  end if;
  if (select (source ->> 'slide')::int from public.flashcards where id = card_a) <> 4 then
    raise exception 'FAIL: a card''s slide reference was not stored';
  end if;

  select updated_at into before_update from public.flashcard_decks where id = deck_a;
  insert into public.flashcard_reviews (flashcard_id, rating) values (card_a, 'again');
  insert into public.flashcard_reviews (flashcard_id, rating) values (card_a, 'easy');
  select count(*) into n from public.flashcard_reviews where flashcard_id = card_a;
  if n <> 2 then raise exception 'FAIL: review ratings were not stored'; end if;
  if (select updated_at from public.flashcard_decks where id = deck_a) < before_update then
    raise exception 'FAIL: reviewing a card moved the deck backwards';
  end if;

  begin
    insert into public.flashcard_reviews (flashcard_id, rating) values (card_a, 'perfect');
    raise exception 'FAIL: an unknown rating was accepted';
  exception when check_violation then null;
  end;

  select count(*) into n from public.flashcard_decks where id = deck_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s deck'; end if;
  select count(*) into n from public.flashcards where id = card_b or front like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s cards'; end if;
  select count(*) into n from public.flashcard_reviews where flashcard_id = card_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s reviews'; end if;

  begin
    insert into public.flashcard_reviews (flashcard_id, rating) values (card_b, 'good');
    raise exception 'FAIL: user A reviewed user B''s card';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.flashcards (deck_id, position, front, back) values (deck_b, 9, 'intruder', 'x');
    raise exception 'FAIL: user A added a card to user B''s deck';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    update public.flashcards set back = 'edited' where id = card_a;
    raise exception 'FAIL: cards can be edited through the API';
  exception when insufficient_privilege then null;
  end;
  delete from public.flashcard_decks where id = deck_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s deck'; end if;

  -- ------------------------------------------------------------------ cascade
  -- Deleting a subject keeps the quiz and the deck, and clears the link.
  delete from public.subjects where id = subject_a;
  if (select subject_id from public.quizzes where id = quiz_a) is not null
     or (select subject_id from public.flashcard_decks where id = deck_a) is not null then
    raise exception 'FAIL: deleting a subject did not clear it from quizzes and decks';
  end if;
  if (select count(*) from public.quiz_questions where quiz_id = quiz_a) <> 3 then
    raise exception 'FAIL: deleting a subject removed a quiz''s questions';
  end if;

  delete from public.quizzes where id = quiz_a;
  delete from public.flashcard_decks where id = deck_a;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  foreach t in array array['quizzes', 'quiz_questions', 'quiz_attempts', 'quiz_answers', 'flashcard_decks', 'flashcards', 'flashcard_reviews'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n <> 0 then raise exception 'FAIL: signed-out visitors can read public.%', t; end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.complete_quiz_attempt(attempt_b);
    raise exception 'FAIL: signed-out visitors can complete attempts';
  exception when insufficient_privilege then null;
  end;

  -- ---------------------------------------------------------- final state
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.quiz_questions where quiz_id = quiz_a;
  if n <> 0 then raise exception 'FAIL: deleting a quiz did not remove its questions'; end if;
  select count(*) into n from public.quiz_attempts where quiz_id = quiz_a;
  if n <> 0 then raise exception 'FAIL: deleting a quiz did not remove its attempts'; end if;
  select count(*) into n from public.quiz_answers where quiz_id = quiz_a;
  if n <> 0 then raise exception 'FAIL: deleting a quiz did not remove its answers'; end if;
  select count(*) into n from public.flashcards where deck_id = deck_a;
  if n <> 0 then raise exception 'FAIL: deleting a deck did not remove its cards'; end if;
  select count(*) into n from public.flashcard_reviews where flashcard_id = card_a;
  if n <> 0 then raise exception 'FAIL: deleting a deck did not remove its reviews'; end if;

  if (select completed_at from public.quiz_attempts where id = attempt_b) is not null
     or (select count(*) from public.quiz_answers where attempt_id = attempt_b) <> 1
     or (select count(*) from public.flashcard_reviews where flashcard_id = card_b) <> 1 then
    raise exception 'FAIL: user B''s quiz or flashcard data was changed';
  end if;

  raise notice 'PASS: quizzes and flashcards are isolated between users, and scores are computed by the database.';
end;
$$;

rollback;
