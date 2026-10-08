import { supabaseConfigProblem } from "./config";

export type SupabaseHealth = {
  status: "ok" | "not_configured" | "unreachable" | "key_rejected" | "unavailable";
  // Where requests are being sent. Not a secret: every browser is told it.
  host?: string;
  // What to fix. Names of settings and status codes only, never a value.
  detail?: string;
};

type Settings = { url: string | undefined; key: string | undefined };

// Whether this deployment can talk to its Supabase project, checked the way
// sign-in does it: from the server, with the configured URL and key. Each way
// it can fail has its own status, so a deployment with a wrong setting says
// which one instead of failing at sign-in.
export async function checkSupabase({ url, key }: Settings, fetcher: typeof fetch = fetch): Promise<SupabaseHealth> {
  const problem = supabaseConfigProblem(url, key);
  if (problem) return { status: "not_configured", detail: problem };

  const base = new URL(url!);
  const host = base.host;
  let response: Response;
  try {
    response = await fetcher(new URL("auth/v1/settings", base), { headers: { apikey: key! }, cache: "no-store", signal: AbortSignal.timeout(8000) });
  } catch (error) {
    // The error's own message can repeat the key; only its code is kept.
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    const reason = typeof cause === "string" ? cause : (error as Error)?.name === "TimeoutError" ? "timed out" : "request failed";
    return { status: "unreachable", host, detail: `no answer from ${host} (${reason}). Check NEXT_PUBLIC_SUPABASE_URL for a typo, and that the project is not paused` };
  }

  if (response.ok) return { status: "ok", host };
  if (response.status === 401 || response.status === 403) {
    return { status: "key_rejected", host, detail: `${host} refused NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (HTTP ${response.status}). Use the publishable key of this same project` };
  }
  if (response.status >= 500) return { status: "unavailable", host, detail: `${host} answered HTTP ${response.status}. The project may be paused or restarting` };
  return { status: "unreachable", host, detail: `${host} answered HTTP ${response.status}, which a Supabase project does not. Check NEXT_PUBLIC_SUPABASE_URL` };
}
