"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, type AuthFormState } from "@/app/(auth)/actions";
import { FormMessage, SubmitButton, TextField } from "./form-fields";

const initialState: AuthFormState = { status: "idle" };

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, initialState);

  if (state.status === "success") {
    return (
      <div className="auth-status">
        <div aria-hidden="true" className="auth-status-icon">✉</div>
        <h1>Check your email</h1>
        <p>Check your email for a password reset link.</p>
        <p className="auth-status-email">{state.values?.email}</p>
        <p className="auth-status-note">If an account exists for this address, the link will arrive within a minute or two.</p>
        <Link className="auth-back" href="/login">← Return to login</Link>
      </div>
    );
  }

  return (
    <>
      <header className="auth-heading">
        <h1>Reset your password</h1>
        <p>Enter the email you use for Ari and we&apos;ll send you a link to choose a new password.</p>
      </header>

      {state.message && <FormMessage tone="error">{state.message}</FormMessage>}

      <form action={action} className="auth-form" noValidate>
        <TextField
          autoComplete="email"
          defaultValue={state.values?.email}
          error={state.fieldErrors?.email}
          inputMode="email"
          label="Email"
          name="email"
          placeholder="you@example.com"
          required
          type="email"
        />
        <SubmitButton pending={pending} pendingLabel="Sending link…">Send reset link</SubmitButton>
      </form>

      <Link className="auth-back" href="/login">← Return to login</Link>
    </>
  );
}
