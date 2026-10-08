import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfig, SESSION_ONLY_COOKIE, withSessionLifetime } from "./config";

export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = getSupabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        const sessionOnly = cookieStore.has(SESSION_ONLY_COOKIE);
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, withSessionLifetime(options, sessionOnly)),
          );
        } catch {
          // Server Components cannot write cookies. The proxy refreshes the
          // session on every request, so this is safe to ignore.
        }
      },
    },
  });
}
