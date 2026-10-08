import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
};

export type CurrentUser = {
  id: string;
  email: string;
};

// The identity comes from the verified session, never from client input.
// `cache` de-duplicates the check within a single request.
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Identity is per-request: never let a page that asks for it be prerendered.
  await connection();
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? "" };
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export const getProfile = cache(async (): Promise<Profile | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  // RLS limits this to the caller's own row; the filter just makes that explicit.
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, avatar_url, bio")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[profile] load failed", { code: error.code });
    return null;
  }
  return data;
});
