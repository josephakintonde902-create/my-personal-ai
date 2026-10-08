-- Phase 9: past-question practice and exam mode, on the Phase 6 quiz tables.
--
-- A practice session or an exam built from past questions is stored exactly
-- like a quiz: a `quizzes` row, a copy of each chosen question in
-- `quiz_questions`, an attempt, and one answer per question. Nothing new is
-- needed to hold them, so the existing tables are extended instead of adding
-- a parallel set:
--
--   * Everything already built on these tables (performance, weak areas,
--     "Ask Ari to explain", the quiz runner) then covers past questions too.
--   * Every change below only WIDENS what is allowed or adds a nullable
--     column. No existing row is rewritten and none becomes invalid.
--
-- Questions are copied rather than referenced so that a finished attempt
-- stays exactly as it was sat, even if the collection is deleted later.

-- ---------------------------------------------------------------------------
-- quizzes: two more modes, larger sizes, and the collection it came from
-- ---------------------------------------------------------------------------
alter table public.quizzes
  drop constraint quizzes_mode_valid,
  add constraint quizzes_mode_valid check (mode in ('quiz', 'practice', 'past_practice', 'exam')),
  -- An exam can be far longer than a generated quiz.
  drop constraint quizzes_question_count_valid,
  add constraint quizzes_question_count_valid check (question_count between 1 and 200),
  -- The one collection a session was drawn from. Null for generated quizzes
  -- and for sessions mixed from several collections. Deleting the collection
  -- keeps the session and clears the link.
  add column past_question_set_id uuid,
  add constraint quizzes_past_question_set_owner_fkey
    foreign key (past_question_set_id, user_id)
    references public.past_question_sets (id, user_id) on delete set null (past_question_set_id);

create index quizzes_user_mode_created_idx on public.quizzes (user_id, mode, created_at desc);
create index quizzes_past_question_set_idx on public.quizzes (past_question_set_id) where past_question_set_id is not null;

grant insert (past_question_set_id) on public.quizzes to authenticated;

-- ---------------------------------------------------------------------------
-- quiz_questions: which past question a copy was made from
-- ---------------------------------------------------------------------------
-- Used to find the past questions a student has not tried yet, or last got
-- wrong. Same-owner by its composite foreign key.
alter table public.quiz_questions
  add column past_question_id uuid,
  add constraint quiz_questions_past_question_owner_fkey
    foreign key (past_question_id, user_id)
    references public.past_questions (id, user_id) on delete set null (past_question_id);

create index quiz_questions_past_question_idx on public.quiz_questions (past_question_id) where past_question_id is not null;

grant insert (past_question_id) on public.quiz_questions to authenticated;

-- ---------------------------------------------------------------------------
-- quiz_attempts: timing and in-progress state for exams
-- ---------------------------------------------------------------------------
alter table public.quiz_attempts
  drop constraint quiz_attempts_total_valid,
  add constraint quiz_attempts_total_valid check (total_questions between 1 and 200),
  -- Null means untimed.
  add column time_limit_seconds integer,
  -- Set when the exam is submitted. Never more than the limit.
  add column time_used_seconds integer,
  -- While an exam is open: { answers: { <question id>: <option index | boolean> }, flagged: [<question id>] }.
  -- After submission: { flagged, late }. Written only by the functions below.
  add column exam_state jsonb,
  add constraint quiz_attempts_time_limit_valid check (time_limit_seconds is null or time_limit_seconds between 60 and 14400),
  add constraint quiz_attempts_time_used_valid check (time_used_seconds is null or time_used_seconds >= 0),
  add constraint quiz_attempts_exam_state_is_object check (exam_state is null or jsonb_typeof(exam_state) = 'object');

-- The time limit is chosen when the attempt is created and cannot be changed.
-- time_used_seconds and exam_state are not granted: clients cannot write them.
grant insert (time_limit_seconds) on public.quiz_attempts to authenticated;

-- ---------------------------------------------------------------------------
-- Exam answers can only be written by submit_exam_attempt()
-- ---------------------------------------------------------------------------
-- In a quiz, each answer is stored as it is given. In an exam nothing is
-- marked until the end, and the marking must not be something a client can
-- supply. This policy is RESTRICTIVE: it is ANDed with the Phase 6 insert
-- policy, so a direct insert into an exam's answers is refused even for the
-- exam's owner. The function below runs as its owner and is not subject to it.
create policy "Exam answers are written only on submission"
  on public.quiz_answers as restrictive for insert to authenticated
  with check (
    not exists (
      select 1 from public.quizzes q
      where q.id = quiz_answers.quiz_id and q.mode = 'exam'
    )
  );

-- Extra time allowed after the limit, for the request to arrive.
create function public.exam_grace_seconds()
returns integer
language sql
immutable
set search_path = ''
as $$ select 30 $$;

-- ---------------------------------------------------------------------------
-- Saving progress during an exam
-- ---------------------------------------------------------------------------
-- Keeps the student's choices on the server while the exam is open, so a
-- refresh or a dropped connection does not lose them. Nothing is marked.
-- Refused once the exam is submitted or its time (plus grace) has passed.
--
-- Runs as the function owner (security definer) because clients have no
-- privilege to update an attempt. It acts on the caller's own attempt only:
-- the owner is always auth.uid(), never an argument.
create function public.save_exam_progress(p_attempt_id uuid, p_answers jsonb, p_flagged jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  -- Shape first, then size: the size checks assume the shape.
  if jsonb_typeof(p_answers) is distinct from 'object' or jsonb_typeof(p_flagged) is distinct from 'array' then
    return false;
  end if;
  if pg_column_size(p_answers) > 32768 or jsonb_array_length(p_flagged) > 200 then
    return false;
  end if;

  update public.quiz_attempts a
     set exam_state = jsonb_build_object('answers', p_answers, 'flagged', p_flagged)
    from public.quizzes q
   where a.id = p_attempt_id
     and a.user_id = v_user
     and a.completed_at is null
     and q.id = a.quiz_id
     and q.user_id = v_user
     and q.mode = 'exam'
     and (
       a.time_limit_seconds is null
       or now() <= a.started_at + make_interval(secs => a.time_limit_seconds + public.exam_grace_seconds())
     );

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Submitting an exam
-- ---------------------------------------------------------------------------
-- Marks the exam and closes it, in one transaction. The client sends only
-- what the student chose: an option's position for multiple choice, true or
-- false otherwise. Each choice is compared here with the stored correct
-- answer, so there is no score, result or correct answer a client could
-- forge. Unanswered questions get no answer row and score nothing.
--
-- A submission that arrives after the time limit (plus grace) is marked from
-- the last progress saved in time, not from what was sent late.
--
-- Submitting twice returns the first result unchanged. Returns null for an
-- attempt that does not exist, belongs to someone else, or is not an exam.
create function public.submit_exam_attempt(p_attempt_id uuid, p_answers jsonb, p_flagged jsonb default '[]'::jsonb)
returns public.quiz_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_attempt public.quiz_attempts;
  v_answers jsonb;
  v_flagged jsonb;
  v_elapsed integer;
  v_late boolean;
  v_question record;
  v_value jsonb;
  v_given jsonb;
  v_index integer;
  v_correct boolean;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select a.* into v_attempt
    from public.quiz_attempts a
    join public.quizzes q on q.id = a.quiz_id and q.user_id = a.user_id
   where a.id = p_attempt_id and a.user_id = v_user and q.mode = 'exam'
     for update of a;

  if not found then
    return null;
  end if;
  if v_attempt.completed_at is not null then
    return v_attempt;
  end if;

  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_attempt.started_at)))::integer);
  v_late := v_attempt.time_limit_seconds is not null
            and v_elapsed > v_attempt.time_limit_seconds + public.exam_grace_seconds();

  if v_late then
    v_answers := coalesce(v_attempt.exam_state -> 'answers', '{}'::jsonb);
    v_flagged := coalesce(v_attempt.exam_state -> 'flagged', '[]'::jsonb);
  else
    v_answers := p_answers;
    v_flagged := p_flagged;
  end if;
  -- Anything that is not what it should be is treated as empty.
  if jsonb_typeof(v_answers) is distinct from 'object' then
    v_answers := '{}'::jsonb;
  elsif pg_column_size(v_answers) > 32768 then
    v_answers := '{}'::jsonb;
  end if;
  if jsonb_typeof(v_flagged) is distinct from 'array' then
    v_flagged := '[]'::jsonb;
  elsif jsonb_array_length(v_flagged) > 200 then
    v_flagged := '[]'::jsonb;
  end if;

  for v_question in
    select q.id, q.question_type, q.options, q.correct_answer
      from public.quiz_questions q
     where q.quiz_id = v_attempt.quiz_id and q.user_id = v_user
  loop
    v_value := v_answers -> (v_question.id::text);
    v_given := null;

    if v_question.question_type = 'multiple_choice' and jsonb_typeof(v_value) = 'number' then
      -- A whole number that names one of this question's options.
      if (v_value #>> '{}') ~ '^[0-9]{1,3}$' then
        v_index := (v_value #>> '{}')::integer;
        if v_index < jsonb_array_length(v_question.options) then
          v_given := v_question.options -> v_index;
        end if;
      end if;
    elsif v_question.question_type = 'true_false' and jsonb_typeof(v_value) = 'boolean' then
      v_given := v_value;
    end if;

    -- Anything else (missing, malformed, or a type an exam does not mark)
    -- counts as unanswered.
    if v_given is not null then
      v_correct := v_given = v_question.correct_answer;
      insert into public.quiz_answers (attempt_id, question_id, quiz_id, user_id, answer, is_correct, result)
      values (v_attempt.id, v_question.id, v_attempt.quiz_id, v_user, v_given, v_correct,
              case when v_correct then 'correct' else 'incorrect' end)
      on conflict (attempt_id, question_id) do nothing;
    end if;
  end loop;

  update public.quiz_attempts a
     set completed_at = now(),
         total_questions = (select count(*) from public.quiz_questions q where q.quiz_id = a.quiz_id),
         score = (select count(*) from public.quiz_answers s where s.attempt_id = a.id and s.is_correct),
         time_used_seconds = case
           when a.time_limit_seconds is null then v_elapsed
           else least(v_elapsed, a.time_limit_seconds)
         end,
         exam_state = jsonb_build_object('flagged', v_flagged, 'late', v_late)
   where a.id = p_attempt_id and a.user_id = v_user
  returning * into v_attempt;

  return v_attempt;
end;
$$;

revoke execute on function public.exam_grace_seconds() from public, anon;
revoke execute on function public.save_exam_progress(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.submit_exam_attempt(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.exam_grace_seconds() to authenticated;
grant execute on function public.save_exam_progress(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.submit_exam_attempt(uuid, jsonb, jsonb) to authenticated;
