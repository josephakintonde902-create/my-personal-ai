-- Phase 3: private storage for study materials.
--
-- Objects live at {user_id}/{subject_id}/{material_id}/{safe_filename}.
-- The bucket is PRIVATE: there are no public URLs. Files are read through
-- short-lived signed URLs created for the owner.
--
-- The size limit and MIME list mirror lib/library/config.ts. Storage enforces
-- them on every upload, so they hold even if the app's own checks are bypassed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-materials',
  'study-materials',
  false,
  52428800, -- 50 MB
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Every policy requires the first path segment to be the caller's own user id.
-- There is no policy for anon, so signed-out requests can do nothing.

create policy "Users can view their own study files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Uploads must also target a subject the caller owns (second path segment),
-- so files cannot be parked in folders that no subject will ever clean up.
-- `objects.name` is qualified on purpose: inside the subquery a bare `name`
-- would mean subjects.name.
create policy "Users can upload study files to their own subjects"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'study-materials'
    and (storage.foldername(objects.name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.subjects s
      where s.id::text = (storage.foldername(objects.name))[2]
        and s.user_id = (select auth.uid())
    )
  );

create policy "Users can update their own study files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete their own study files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
