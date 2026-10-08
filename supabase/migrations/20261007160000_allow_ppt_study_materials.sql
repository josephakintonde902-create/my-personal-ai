-- Allow legacy PowerPoint (.ppt, PowerPoint 97–2003) uploads.
--
-- The list mirrors SUPPORTED_MATERIAL_TYPES in lib/library/config.ts. Storage
-- enforces it on every upload, so a type must be added here as well as in the
-- app. This is the Phase 3 list plus application/vnd.ms-powerpoint.

update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/vnd.ms-powerpoint',
         'text/plain',
         'image/png',
         'image/jpeg',
         'image/webp'
       ]
 where id = 'study-materials';
