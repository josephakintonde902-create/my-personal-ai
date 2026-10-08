import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { LOGIN_NOTICES } from "@/lib/auth/errors";
import { safeNextPath } from "@/lib/auth/routes";

export const metadata: Metadata = { title: "Sign in — Ari" };

type Props = { searchParams: Promise<{ next?: string | string[]; notice?: string | string[] }> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? safeNextPath(params.next) : undefined;
  const notice = typeof params.notice === "string" ? LOGIN_NOTICES[params.notice] : undefined;

  return (
    <>
      <header className="auth-heading">
        <h1>Welcome back to Ari</h1>
        <p>Your AI study tutor is ready to continue where you left off.</p>
      </header>
      <LoginForm
        googleEnabled={process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true"}
        next={next}
        notice={notice}
      />
    </>
  );
}
