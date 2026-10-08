import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { getCurrentUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Choose a new password — Ari" };

export default async function ResetPasswordPage() {
  // A valid reset link signs the user in before they arrive here. No session
  // means the link was invalid, already used, or has expired.
  const user = await getCurrentUser();

  if (!user) {
    return (
      <div className="auth-status">
        <div aria-hidden="true" className="auth-status-icon warn">!</div>
        <h1>This reset link has expired</h1>
        <p>Reset links can only be used once and stop working after a short time.</p>
        <Link className="auth-submit" href="/forgot-password">Request a new link</Link>
        <Link className="auth-back" href="/login">← Return to login</Link>
      </div>
    );
  }

  return (
    <>
      <header className="auth-heading">
        <h1>Choose a new password</h1>
        <p>Pick something you haven&apos;t used before. You&apos;ll sign in with it next.</p>
      </header>
      <ResetPasswordForm />
    </>
  );
}
