import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/routes";
import { createClient } from "@/lib/supabase/server";

// Landing point for links in Supabase emails (verification, password reset)
// and for OAuth. Exchanges the one-time code for a session.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const isRecovery = next === "/reset-password";
  const code = searchParams.get("code");

  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) return NextResponse.redirect(new URL(next, origin));
      console.error("[auth] code exchange failed", { code: error.code, status: error.status });
    } catch {
      console.error("[auth] code exchange failed");
    }
  }

  // Supabase reports an expired or already-used link through these parameters.
  const expired = searchParams.get("error_code") === "otp_expired";
  if (isRecovery) {
    return NextResponse.redirect(new URL("/reset-password", origin));
  }
  return NextResponse.redirect(new URL(`/login?notice=${expired ? "link_expired" : "link_invalid"}`, origin));
}
