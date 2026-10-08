import type { CookieOptions } from "@supabase/ssr";

// Both values are safe to expose to the browser. Row Level Security is what
// protects data; the service-role key is never used by this application.
export class SupabaseConfigError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = "SupabaseConfigError";
  }
}

// What is wrong with the two settings, or null if they can be used. Names
// only, never the values. A value that is present but malformed is caught
// here because otherwise it fails later as a request that never leaves the
// server, which looks exactly like a network outage.
export function supabaseConfigProblem(url: string | undefined, key: string | undefined): string | null {
  const missing = [!url && "NEXT_PUBLIC_SUPABASE_URL", !key && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"].filter(Boolean);
  if (missing.length > 0) return `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set`;

  let parsed: URL | null = null;
  try {
    parsed = new URL(url!);
  } catch {
    // Reported below.
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return "NEXT_PUBLIC_SUPABASE_URL is not a URL. It should look like https://<project-ref>.supabase.co, with no quotes";
  if (parsed.hostname === "supabase.com" || parsed.hostname.endsWith(".supabase.com")) {
    return "NEXT_PUBLIC_SUPABASE_URL is a Supabase dashboard address. Use the project's API URL, https://<project-ref>.supabase.co";
  }
  if (parsed.hostname === "your-project-ref.supabase.co") return "NEXT_PUBLIC_SUPABASE_URL is still the placeholder from .env.example";
  if (parsed.pathname !== "/" || parsed.search) return "NEXT_PUBLIC_SUPABASE_URL has a path after the address. Use only https://<project-ref>.supabase.co";

  // Anything else cannot be sent in a request header at all.
  if (!/^[\x21-\x7e]+$/.test(key!)) return "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY contains a space, a line break or another character that is not part of a key. Paste it again";
  if (/^["']|["']$/.test(key!)) return "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is wrapped in quotes. Remove them";
  if (/^sb_publishable_x+$/.test(key!)) return "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is still the placeholder from .env.example";
  if (/^sb_secret_/.test(key!)) return "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable key, and rotate the secret one";
  return null;
}

export function getSupabaseConfig() {
  // Read by their full names so that Next.js can inline them for the browser.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  const problem = supabaseConfigProblem(url, key);
  if (problem) {
    throw new SupabaseConfigError(
      `Supabase is not configured: ${problem}. Set it in .env.local, or in the hosting provider's environment variables and redeploy.`,
    );
  }

  return { url: url!, key: key! };
}

export function isSupabaseConfigured() {
  return supabaseConfigProblem(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()) === null;
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
