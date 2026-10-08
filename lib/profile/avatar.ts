// Must match the bucket limits in supabase/migrations/*_create_avatars_bucket.sql.
// The bucket enforces these too; the client checks only give faster feedback.
export const AVATAR_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];

// One fixed object per user, inside a folder named after their user id.
// Storage policies only allow writes where that folder matches auth.uid().
export function avatarPath(userId: string) {
  return `${userId}/profile-image`;
}
