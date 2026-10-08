import type { CookieOptions } from "@supabase/ssr";

// Both values are safe to expose to the browser. Row Level Security is what
// protects data; the service-role key is never used by this application.
export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.",
    );
  }

  return { url, key };
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

// Set at sign-in when "Keep me signed in" is unchecked. While present, auth
// cookies are written without an expiry so they end with the browser session.
export const SESSION_ONLY_COOKIE = "ari-session-only";

export function withSessionLifetime(options: CookieOptions, sessionOnly: boolean): CookieOptions {
  // Leave deletions (maxAge 0) untouched so sign-out still clears the cookies.
  if (!sessionOnly || !options.maxAge) return options;

  const sessionOptions = { ...options };
  delete sessionOptions.maxAge;
  delete sessionOptions.expires;
  return sessionOptions;
}
