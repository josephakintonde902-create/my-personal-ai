import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/routes";
import { createClient } from "@/lib/supabase/server";

const SUPPORTED_TYPES: EmailOtpType[] = ["signup", "email", "recovery"];

// Handles token-hash links, used when the Supabase email templates point here
// (see README). Unlike the code flow, these work when the email is opened on a
// different device or browser from the one that requested it.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const isRecovery = type === "recovery";
  const next = isRecovery ? "/reset-password" : safeNextPath(searchParams.get("next"));

  let expired = false;
  if (tokenHash && type && SUPPORTED_TYPES.includes(type)) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (!error) return NextResponse.redirect(new URL(next, origin));
      expired = error.code === "otp_expired";
      console.error("[auth] link verification failed", { code: error.code, status: error.status });
    } catch {
      console.error("[auth] link verification failed");
    }
  }

  if (isRecovery) return NextResponse.redirect(new URL("/reset-password", origin));
  return NextResponse.redirect(new URL(`/login?notice=${expired ? "link_expired" : "link_invalid"}`, origin));
}
