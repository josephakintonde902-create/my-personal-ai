-- Row Level Security check for public.profiles.
--
-- Run in the Supabase SQL Editor after at least TWO accounts have signed up.
-- It impersonates each user the same way the API does, tries to read and
-- change the other user's profile, and raises an error if anything leaks.
-- Everything is rolled back, so no data is changed.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  visible int;
  changed int;
begin
  select id into user_a from auth.users order by created_at limit 1;
  select id into user_b from auth.users where id <> user_a order by created_at limit 1;
  if user_b is null then
    raise exception 'Need two signed-up users to run this check.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'FAIL: RLS is not enabled on public.profiles';
  end if;

  -- Act as user A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  select count(*) into visible from public.profiles;
  if visible <> 1 then raise exception 'FAIL: user A can see % profiles (expected 1)', visible; end if;

  select count(*) into visible from public.profiles where id = user_b;
  if visible <> 0 then raise exception 'FAIL: user A can read user B''s profile'; end if;

  update public.profiles set bio = 'changed by A' where id = user_b;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'FAIL: user A can update user B''s profile'; end if;

  update public.profiles set bio = 'my own bio' where id = user_a;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'FAIL: user A cannot update their own profile'; end if;

  -- Act as user B.
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  select count(*) into visible from public.profiles where id = user_a;
  if visible <> 0 then raise exception 'FAIL: user B can read user A''s profile'; end if;

  update public.profiles set full_name = 'changed by B' where id = user_a;
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'FAIL: user B can update user A''s profile'; end if;

  -- Act as a signed-out visitor.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into visible from public.profiles;
    if visible <> 0 then raise exception 'FAIL: signed-out visitors can read profiles'; end if;
  exception when insufficient_privilege then
    null; -- expected: anon has no privileges on the table at all
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'PASS: profiles are isolated between users and hidden from signed-out visitors.';
end;
$$;

rollback;
