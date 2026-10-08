import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./config";

// A Supabase client that acts as one signed-in user, identified by their
// access token rather than by request cookies. It is used for work that
// continues after the response has been sent (document processing), where
// cookies can no longer be relied on.
//
// It carries the user's own permissions, not elevated ones: Row Level
// Security applies to everything it does. The service-role key is not used.
export function createUserClient(accessToken: string) {
  const { url, key } = getSupabaseConfig();
  return createSupabaseClient(url, key, { accessToken: async () => accessToken });
}
