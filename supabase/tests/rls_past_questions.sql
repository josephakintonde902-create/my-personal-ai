-- Phase 9 check: past questions, practice sessions and exams are isolated
-- between users, official answers cannot be altered, and an exam's score can
-- only come from submit_exam_attempt().
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up
-- and the Phase 9 migrations (20261008090000, 20261008090100) have been
-- applied. It impersonates each user the same way the API does, creates test
-- rows, and raises an error on the first rule that leaks. Everything is
-- rolled back.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  subject_a uuid;
  subject_b uuid;
  set_a uuid := gen_random_uuid();
  set_b uuid := gen_random_uuid();
  pq_a1 uuid;
  pq_a2 uuid;
  pq_a3 uuid;
  pq_b uuid;
  exam_a uuid;
  exam_b uuid;
  practice_a uuid;
  q_a1 uuid;
  q_a2 uuid;
  q_a3 uuid;
  q_b uuid;
  q_practice uuid;
  attempt_a uuid;
  attempt_late uuid;
  attempt_b uuid;
  attempt_practice uuid;
  outcome public.quiz_attempts;
  scratch uuid;
  n int;
  t text;
begin
  select id into user_a from auth.users order by created_at, id limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at, id limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  foreach t in array array['past_question_sets', 'past_questions', 'quizzes', 'quiz_questions', 'quiz_attempts', 'quiz_answers'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: RLS is not enabled on public.%', t;
    end if;
  end loop;

  -- ------------------------------------------------------------------ user B
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Past questions test B ' || gen_random_uuid()) returning id into subject_b;
  insert into public.past_question_sets (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
  values (set_b, subject_b, 'B SECRET paper', 'b.pdf', user_b || '/' || subject_b || '/' || set_b || '/b.pdf', 'application/pdf', 10, 'pdf');
  insert into public.past_questions (set_id, position, question_number, question, question_type, options, correct_answer, answer_source)
  values (set_b, 0, '1', 'B SECRET question', 'multiple_choice', '["B one","B two"]'::jsonb, '"B one"'::jsonb, 'official')
  returning id into pq_b;

  insert into public.quizzes (subject_id, past_question_set_id, title, mode, difficulty, question_count, question_types)
  values (subject_b, set_b, 'Exam: B SECRET paper', 'exam', 'mixed', 1, array['multiple_choice']) returning id into exam_b;
  insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, options, correct_answer, explanation)
  values (exam_b, pq_b, 0, 'B SECRET question', 'multiple_choice', '["B one","B two"]'::jsonb, '"B one"'::jsonb, 'B SECRET explanation')
  returning id into q_b;
  insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_b, 1, 1800) returning id into attempt_b;

  -- ------------------------------------------------------------------ user A
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.subjects (name) values ('Past questions test A ' || gen_random_uuid()) returning id into subject_a;

  -- ---------------------------------------------------- creating a collection
  insert into public.past_question_sets (id, subject_id, title, exam_type, exam_year, original_filename, file_path, mime_type, file_size, file_extension)
  values (set_a, subject_a, 'Anatomy 2022', 'University Examination', 2022, 'a.pdf', user_a || '/' || subject_a || '/' || set_a || '/a.pdf', 'application/pdf', 10, 'pdf');

  if (select user_id from public.past_question_sets where id = set_a) is distinct from user_a then
    raise exception 'FAIL: a new collection is not owned by the user who created it';
  end if;
  if (select processing_status from public.past_question_sets where id = set_a) <> 'pending' then
    raise exception 'FAIL: a new collection does not start as pending';
  end if;

  -- Only the title is required beyond the file: every other detail is optional.
  scratch := gen_random_uuid();
  begin
    insert into public.past_question_sets (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
    values (scratch, subject_a, '   ', 'x.pdf', user_a || '/' || subject_a || '/' || scratch || '/x.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: a collection was created with an empty title';
  exception when check_violation then null;
  end;
  -- The file must be in the collection's own folder.
  begin
    insert into public.past_question_sets (subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
    values (subject_a, 'stolen file', 'b.pdf', user_b || '/' || subject_b || '/' || set_b || '/b.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: a collection was pointed at another user''s file';
  exception when check_violation or unique_violation then null;
  end;
  begin
    insert into public.past_question_sets (id, subject_id, title, exam_year, original_filename, file_path, mime_type, file_size, file_extension)
    values (scratch, subject_a, 'bad year', 3024, 'x.pdf', user_a || '/' || subject_a || '/' || scratch || '/x.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: an impossible year was accepted';
  exception when check_violation then null;
  end;
  -- Not in another user's subject, and not owned by another user.
  begin
    insert into public.past_question_sets (id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
    values (scratch, subject_b, 'borrowed subject', 'x.pdf', user_a || '/' || subject_b || '/' || scratch || '/x.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: user A created a collection in user B''s subject';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    insert into public.past_question_sets (user_id, subject_id, title, original_filename, file_path, mime_type, file_size, file_extension)
    values (user_b, subject_b, 'forged owner', 'x.pdf', user_b || '/' || subject_b || '/' || gen_random_uuid() || '/x.pdf', 'application/pdf', 10, 'pdf');
    raise exception 'FAIL: user A created a collection owned by user B';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------------------- adding questions
  insert into public.past_questions (set_id, position, question_number, question, question_type, options, correct_answer, answer_source, exam_year, page_number)
  values (set_a, 0, '1', 'Which nerve supplies the superior oblique?', 'multiple_choice', '["Trochlear","Facial","Vagus","Optic"]'::jsonb, '"Trochlear"'::jsonb, 'official', 2022, 1)
  returning id into pq_a1;
  insert into public.past_questions (set_id, position, question_number, question, question_type, options)
  values (set_a, 1, '2', 'Which vessel leaves the left ventricle?', 'multiple_choice', '["Aorta","Vena cava"]'::jsonb)
  returning id into pq_a2;
  insert into public.past_questions (set_id, position, question_number, question, question_type, correct_answer, answer_source)
  values (set_a, 2, '3', 'The trachea is anterior to the oesophagus.', 'true_false', 'true'::jsonb, 'official')
  returning id into pq_a3;
  insert into public.past_questions (set_id, position, question, question_type)
  values (set_a, 3, 'Text that could not be read as a question.', 'raw');

  if (select answer_source from public.past_questions where id = pq_a2) <> 'answer_unavailable' then
    raise exception 'FAIL: a question with no answer is not marked answer_unavailable';
  end if;

  -- An answer must say where it came from, and "unavailable" has none.
  begin
    insert into public.past_questions (set_id, position, question, question_type, correct_answer)
    values (set_a, 10, 'Answer with no source?', 'short_answer', '"x"'::jsonb);
    raise exception 'FAIL: an answer was stored without a source';
  exception when check_violation then null;
  end;
  begin
    insert into public.past_questions (set_id, position, question, question_type, answer_source)
    values (set_a, 10, 'Official with no answer?', 'short_answer', 'official');
    raise exception 'FAIL: a question was marked official with no answer';
  exception when check_violation then null;
  end;
  begin
    insert into public.past_questions (set_id, position, question, question_type, correct_answer, answer_source)
    values (set_a, 10, 'Raw text with an answer?', 'raw', '"x"'::jsonb, 'official');
    raise exception 'FAIL: raw text was given an answer';
  exception when check_violation then null;
  end;
  begin
    insert into public.past_questions (set_id, position, question, question_type) values (set_a, 0, 'Same position twice', 'short_answer');
    raise exception 'FAIL: two questions took the same position';
  exception when unique_violation then null;
  end;

  -- ---------------------------- official answers and question text are fixed
  begin
    update public.past_questions set correct_answer = '"Facial"'::jsonb where id = pq_a1;
    raise exception 'FAIL: an official answer was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.past_questions set answer_source = 'ai_generated' where id = pq_a1;
    raise exception 'FAIL: an official answer was relabelled';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.past_questions set correct_answer = '"Aorta"'::jsonb, answer_source = 'official' where id = pq_a2;
    raise exception 'FAIL: an answer was marked official after upload';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.past_questions set question = 'Rewritten' where id = pq_a1;
    raise exception 'FAIL: a question''s wording can be edited';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.past_questions set options = '["Trochlear"]'::jsonb where id = pq_a1;
    raise exception 'FAIL: a question''s options can be edited';
  exception when insufficient_privilege then null;
  end;

  -- Analysis may label any question, and may answer one the paper did not.
  update public.past_questions set topic = 'Cranial Nerves', difficulty = 'medium', analyzed_at = now() where id = pq_a1;
  update public.past_questions
     set topic = 'Cardiovascular System', analyzed_at = now(), correct_answer = '"Aorta"'::jsonb, answer_source = 'ai_generated',
         explanation = 'The aorta carries blood from the left ventricle.', explanation_source = 'ai_generated'
   where id = pq_a2;
  if (select answer_source from public.past_questions where id = pq_a2) <> 'ai_generated'
     or (select topic from public.past_questions where id = pq_a1) <> 'Cranial Nerves'
     or (select correct_answer from public.past_questions where id = pq_a1) <> '"Trochlear"'::jsonb then
    raise exception 'FAIL: analysis could not label questions, or disturbed an official answer';
  end if;

  -- ----------------------------------- A cannot see or touch B's collection
  select count(*) into n from public.past_question_sets where id = set_b or title like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s past-question set'; end if;
  select count(*) into n from public.past_questions where id = pq_b or set_id = set_b or question like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s past questions'; end if;

  begin
    insert into public.past_questions (set_id, position, question, question_type) values (set_b, 5, 'intruder', 'short_answer');
    raise exception 'FAIL: user A added a question to user B''s collection';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  update public.past_question_sets set title = 'renamed by A' where id = set_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can rename user B''s collection'; end if;
  update public.past_questions set topic = 'set by A' where id = pq_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can label user B''s question'; end if;
  delete from public.past_questions where id = pq_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s question'; end if;
  delete from public.past_question_sets where id = set_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s collection'; end if;

  -- A's own collection cannot be handed to another owner or subject.
  begin
    update public.past_question_sets set user_id = user_b where id = set_a;
    raise exception 'FAIL: a collection''s owner can be changed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.past_question_sets set subject_id = subject_b where id = set_a;
    raise exception 'FAIL: a collection''s subject can be changed';
  exception when insufficient_privilege then null;
  end;

  -- ---------------------------------------------- sessions from past questions
  -- A session cannot be linked to another user's collection or question.
  begin
    insert into public.quizzes (past_question_set_id, title, mode, difficulty, question_count, question_types)
    values (set_b, 'borrowed set', 'past_practice', 'mixed', 1, array['multiple_choice']);
    raise exception 'FAIL: user A made a session from user B''s collection';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  insert into public.quizzes (subject_id, past_question_set_id, title, mode, difficulty, question_count, question_types)
  values (subject_a, set_a, 'Exam: Anatomy 2022', 'exam', 'mixed', 3, array['multiple_choice', 'true_false']) returning id into exam_a;

  begin
    insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, options, correct_answer, explanation)
    values (exam_a, pq_b, 9, 'borrowed question', 'multiple_choice', '["B one","B two"]'::jsonb, '"B one"'::jsonb, 'x');
    raise exception 'FAIL: user A copied user B''s past question into a session';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;

  insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, options, correct_answer, explanation, metadata)
  values (exam_a, pq_a1, 0, 'Which nerve supplies the superior oblique?', 'multiple_choice', '["Trochlear","Facial","Vagus","Optic"]'::jsonb, '"Trochlear"'::jsonb, 'x', '{"topic":"Cranial Nerves","answerSource":"official"}'::jsonb)
  returning id into q_a1;
  insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, options, correct_answer, explanation, metadata)
  values (exam_a, pq_a2, 1, 'Which vessel leaves the left ventricle?', 'multiple_choice', '["Aorta","Vena cava"]'::jsonb, '"Aorta"'::jsonb, 'x', '{"topic":"Cardiovascular System","answerSource":"ai_generated"}'::jsonb)
  returning id into q_a2;
  insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, correct_answer, explanation)
  values (exam_a, pq_a3, 2, 'The trachea is anterior to the oesophagus.', 'true_false', 'true'::jsonb, 'x')
  returning id into q_a3;

  -- A session may now hold more than twenty questions, and no more than 200.
  insert into public.quizzes (title, mode, difficulty, question_count, question_types) values ('Large session', 'past_practice', 'mixed', 200, array['multiple_choice']);
  begin
    insert into public.quizzes (title, mode, difficulty, question_count, question_types) values ('Too large', 'exam', 'mixed', 201, array['multiple_choice']);
    raise exception 'FAIL: a session of more than 200 questions was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.quizzes (title, mode, difficulty, question_count, question_types) values ('Unknown mode', 'mock', 'mixed', 1, array['multiple_choice']);
    raise exception 'FAIL: an unknown session mode was accepted';
  exception when check_violation then null;
  end;

  -- ----------------------------------------------------------- sitting an exam
  insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_a, 3, 1800) returning id into attempt_a;

  begin
    insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_a, 3, 5);
    raise exception 'FAIL: a five-second exam was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_a, 3, 999999);
    raise exception 'FAIL: an exam of unreasonable length was accepted';
  exception when check_violation then null;
  end;
  -- Timing, state and score cannot be supplied or edited by the client.
  begin
    insert into public.quiz_attempts (quiz_id, total_questions, time_used_seconds) values (exam_a, 3, 1);
    raise exception 'FAIL: an attempt was created with a time already used';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.quiz_attempts (quiz_id, total_questions, exam_state) values (exam_a, 3, '{}'::jsonb);
    raise exception 'FAIL: an attempt was created with exam state';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.quiz_attempts set score = 3, completed_at = now() where id = attempt_a;
    raise exception 'FAIL: a user can write their own exam score';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.quiz_attempts set time_limit_seconds = 14400, started_at = now() where id = attempt_a;
    raise exception 'FAIL: a user can extend their own exam';
  exception when insufficient_privilege then null;
  end;

  -- An exam's answers cannot be written directly, even by its owner: that
  -- would let a client mark itself.
  begin
    insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
    values (attempt_a, q_a1, exam_a, '"Facial"'::jsonb, true, 'correct');
    raise exception 'FAIL: a forged exam answer was accepted';
  exception when insufficient_privilege then null;
  end;

  -- Progress can be saved while the exam is open. Nothing is marked.
  if not public.save_exam_progress(attempt_a, jsonb_build_object(q_a1::text, 0), jsonb_build_array(q_a2::text)) then
    raise exception 'FAIL: progress could not be saved in an open exam';
  end if;
  if public.save_exam_progress(attempt_a, '[]'::jsonb, '[]'::jsonb) or public.save_exam_progress(attempt_a, '{}'::jsonb, '{}'::jsonb) then
    raise exception 'FAIL: malformed progress was saved';
  end if;
  select count(*) into n from public.quiz_answers where attempt_id = attempt_a;
  if n <> 0 then raise exception 'FAIL: saving progress marked answers'; end if;
  if (select completed_at from public.quiz_attempts where id = attempt_a) is not null then
    raise exception 'FAIL: saving progress completed the exam';
  end if;

  -- Submitting marks it: q1 right (option 0), q2 wrong (option 1), q3 left
  -- out. Out-of-range, mistyped and foreign entries are ignored.
  outcome := public.submit_exam_attempt(
    attempt_a,
    jsonb_build_object(q_a1::text, 0, q_a2::text, 1, q_b::text, 0, 'not-a-question', 0, 'score', 3),
    jsonb_build_array(q_a2::text)
  );
  if outcome.score is distinct from 1 or outcome.total_questions <> 3 or outcome.completed_at is null then
    raise exception 'FAIL: submitting gave score %, total % (expected 1 of 3)', outcome.score, outcome.total_questions;
  end if;
  if outcome.time_used_seconds is null or outcome.time_used_seconds > 1800 or (outcome.exam_state ->> 'late')::boolean then
    raise exception 'FAIL: the time used was not recorded correctly';
  end if;
  if outcome.exam_state -> 'flagged' <> jsonb_build_array(q_a2::text) then
    raise exception 'FAIL: the questions marked for review were not kept';
  end if;
  select count(*) into n from public.quiz_answers where attempt_id = attempt_a;
  if n <> 2 then raise exception 'FAIL: expected 2 stored answers (one question was left out), found %', n; end if;
  if (select result from public.quiz_answers where attempt_id = attempt_a and question_id = q_a1) <> 'correct'
     or (select result from public.quiz_answers where attempt_id = attempt_a and question_id = q_a2) <> 'incorrect'
     or (select answer from public.quiz_answers where attempt_id = attempt_a and question_id = q_a2) <> '"Vena cava"'::jsonb then
    raise exception 'FAIL: the answers were not marked against the stored correct answers';
  end if;

  -- Submitting again changes nothing, whatever is sent.
  if (public.submit_exam_attempt(attempt_a, jsonb_build_object(q_a1::text, 0, q_a2::text, 0, q_a3::text, true))).score is distinct from 1 then
    raise exception 'FAIL: submitting twice changed the score';
  end if;
  if public.save_exam_progress(attempt_a, '{}'::jsonb, '[]'::jsonb) then
    raise exception 'FAIL: progress was saved in a finished exam';
  end if;
  begin
    update public.quiz_answers set is_correct = true, result = 'correct' where attempt_id = attempt_a;
    raise exception 'FAIL: exam answers can be edited after submission';
  exception when insufficient_privilege then null;
  end;

  -- Malformed choices count as unanswered rather than as errors.
  insert into public.quiz_attempts (quiz_id, total_questions) values (exam_a, 3) returning id into attempt_late;
  outcome := public.submit_exam_attempt(attempt_late, jsonb_build_object(q_a1::text, 99, q_a2::text, 'Aorta', q_a3::text, 'true'));
  if outcome.score is distinct from 0 or (select count(*) from public.quiz_answers where attempt_id = attempt_late) <> 0 then
    raise exception 'FAIL: malformed answers were marked';
  end if;
  if outcome.time_used_seconds is null then raise exception 'FAIL: an untimed exam recorded no time used'; end if;

  -- ------------------------------------------------------------ the time limit
  -- An exam started an hour ago with a thirty-minute limit.
  insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_a, 3, 1800) returning id into attempt_late;
  if not public.save_exam_progress(attempt_late, jsonb_build_object(q_a3::text, true), '[]'::jsonb) then
    raise exception 'FAIL: progress could not be saved before the time limit';
  end if;
  perform set_config('role', 'postgres', true);
  update public.quiz_attempts set started_at = now() - interval '1 hour' where id = attempt_late;
  perform set_config('role', 'authenticated', true);

  if public.save_exam_progress(attempt_late, jsonb_build_object(q_a1::text, 0, q_a2::text, 0, q_a3::text, true), '[]'::jsonb) then
    raise exception 'FAIL: progress was saved after the time limit';
  end if;
  -- A late submission is marked from what was saved in time (one answer),
  -- not from the three answers sent late.
  outcome := public.submit_exam_attempt(attempt_late, jsonb_build_object(q_a1::text, 0, q_a2::text, 0, q_a3::text, true));
  if outcome.score is distinct from 1 or not (outcome.exam_state ->> 'late')::boolean then
    raise exception 'FAIL: a late submission was marked from the late answers (score %)', outcome.score;
  end if;
  if outcome.time_used_seconds <> 1800 then
    raise exception 'FAIL: time used (%) exceeds the time allowed', outcome.time_used_seconds;
  end if;

  -- ------------------------------------------ practice sessions are unaffected
  insert into public.quizzes (subject_id, past_question_set_id, title, mode, difficulty, question_count, question_types)
  values (subject_a, set_a, 'Practice: Anatomy 2022', 'past_practice', 'mixed', 1, array['multiple_choice']) returning id into practice_a;
  insert into public.quiz_questions (quiz_id, past_question_id, position, question, question_type, options, correct_answer, explanation)
  values (practice_a, pq_a1, 0, 'Which nerve supplies the superior oblique?', 'multiple_choice', '["Trochlear","Facial","Vagus","Optic"]'::jsonb, '"Trochlear"'::jsonb, 'x')
  returning id into q_practice;
  insert into public.quiz_attempts (quiz_id, total_questions) values (practice_a, 1) returning id into attempt_practice;
  -- Answered one at a time, as in any quiz.
  insert into public.quiz_answers (attempt_id, question_id, quiz_id, answer, is_correct, result)
  values (attempt_practice, q_practice, practice_a, '"Trochlear"'::jsonb, true, 'correct');
  if (public.complete_quiz_attempt(attempt_practice)).score is distinct from 1 then
    raise exception 'FAIL: a past-question practice session was not scored like a quiz';
  end if;
  -- The exam functions do nothing to a session that is not an exam.
  if (public.submit_exam_attempt(attempt_practice, '{}'::jsonb)).id is not null or public.save_exam_progress(attempt_practice, '{}'::jsonb, '[]'::jsonb) then
    raise exception 'FAIL: an exam function acted on a practice session';
  end if;

  -- ---------------------------------------------- A cannot reach B's exam
  select count(*) into n from public.quizzes where id = exam_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s exam'; end if;
  select count(*) into n from public.quiz_questions where quiz_id = exam_b or question like 'B SECRET%';
  if n <> 0 then raise exception 'FAIL: user A can read user B''s exam questions'; end if;
  select count(*) into n from public.quiz_attempts where id = attempt_b;
  if n <> 0 then raise exception 'FAIL: user A can read user B''s exam attempt'; end if;

  if public.save_exam_progress(attempt_b, jsonb_build_object(q_b::text, 1), '[]'::jsonb) then
    raise exception 'FAIL: user A saved progress in user B''s exam';
  end if;
  if (public.submit_exam_attempt(attempt_b, jsonb_build_object(q_b::text, 1))).id is not null then
    raise exception 'FAIL: user A submitted user B''s exam';
  end if;
  begin
    insert into public.quiz_attempts (quiz_id, total_questions, time_limit_seconds) values (exam_b, 1, 600);
    raise exception 'FAIL: user A started an attempt at user B''s exam';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  delete from public.quizzes where id = exam_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user A can delete user B''s exam'; end if;

  -- ------------------------------------------------------------------ user B
  -- The same holds the other way round.
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  select count(*) into n from public.past_question_sets where id = set_a;
  if n <> 0 then raise exception 'FAIL: user B can read user A''s past-question set'; end if;
  select count(*) into n from public.past_questions where set_id = set_a;
  if n <> 0 then raise exception 'FAIL: user B can read user A''s past questions'; end if;
  select count(*) into n from public.quiz_attempts where quiz_id = exam_a;
  if n <> 0 then raise exception 'FAIL: user B can read user A''s exam attempts'; end if;
  select count(*) into n from public.quiz_answers where quiz_id in (exam_a, practice_a);
  if n <> 0 then raise exception 'FAIL: user B can read user A''s answers'; end if;
  update public.past_questions set topic = 'set by B' where set_id = set_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user B can change user A''s past questions'; end if;
  delete from public.past_question_sets where id = set_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: user B can delete user A''s collection'; end if;
  if (public.submit_exam_attempt(attempt_a, '{}'::jsonb)).id is not null then
    raise exception 'FAIL: user B could submit user A''s exam';
  end if;

  -- B's own exam is still open and unmarked after everything A tried.
  if (select completed_at from public.quiz_attempts where id = attempt_b) is not null
     or (select exam_state from public.quiz_attempts where id = attempt_b) is not null
     or (select count(*) from public.quiz_answers where attempt_id = attempt_b) <> 0 then
    raise exception 'FAIL: user B''s exam was changed by user A';
  end if;
  outcome := public.submit_exam_attempt(attempt_b, jsonb_build_object(q_b::text, 0));
  if outcome.score is distinct from 1 then raise exception 'FAIL: user B could not submit their own exam'; end if;

  -- ------------------------------------------------------------------ cascade
  -- Deleting a collection removes its questions but keeps the sessions and
  -- exams already taken from it, with their scores, and clears the links.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
  delete from public.past_question_sets where id = set_a;

  select count(*) into n from public.past_questions where set_id = set_a;
  if n <> 0 then raise exception 'FAIL: deleting a collection did not remove its questions'; end if;
  if (select past_question_set_id from public.quizzes where id = exam_a) is not null
     or (select count(*) from public.quiz_questions where quiz_id = exam_a and past_question_id is not null) <> 0 then
    raise exception 'FAIL: deleting a collection did not clear it from its sessions';
  end if;
  if (select score from public.quiz_attempts where id = attempt_a) is distinct from 1
     or (select count(*) from public.quiz_questions where quiz_id = exam_a) <> 3
     or (select count(*) from public.quiz_answers where attempt_id = attempt_a) <> 2 then
    raise exception 'FAIL: deleting a collection changed a finished exam';
  end if;

  -- ------------------------------------------------------- signed-out visitor
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  foreach t in array array['past_question_sets', 'past_questions', 'quiz_attempts', 'quiz_answers'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n <> 0 then raise exception 'FAIL: signed-out visitors can read public.%', t; end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.submit_exam_attempt(attempt_b, '{}'::jsonb);
    raise exception 'FAIL: signed-out visitors can submit exams';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_exam_progress(attempt_b, '{}'::jsonb, '[]'::jsonb);
    raise exception 'FAIL: signed-out visitors can save exam progress';
  exception when insufficient_privilege then null;
  end;

  raise notice 'PASS: past questions and exams are isolated between users, official answers are protected, and exams are marked by the database.';
end;
$$;

rollback;
