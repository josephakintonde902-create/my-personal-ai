"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { resendVerification, signUp, type AuthFormState } from "@/app/(auth)/actions";
import { FULL_NAME_MAX_LENGTH, passwordRules } from "@/lib/auth/validation";
import { FormMessage, PasswordField, SubmitButton, TextField } from "./form-fields";

const initialState: AuthFormState = { status: "idle" };

export function SignupForm() {
  const [state, action, pending] = useActionState(signUp, initialState);
  const [password, setPassword] = useState("");

  if (state.status === "success" && state.values?.email) {
    return <CheckEmail email={state.values.email} />;
  }

  return (
    <>
      <header className="auth-heading">
        <h1>Create your Ari account</h1>
        <p>Build your personalized study space and learn smarter with Ari.</p>
      </header>

      {state.message && <FormMessage tone="error">{state.message}</FormMessage>}

      <form action={action} className="auth-form" noValidate>
        <TextField
          autoComplete="name"
          defaultValue={state.values?.fullName}
          error={state.fieldErrors?.fullName}
          label="Full name"
          maxLength={FULL_NAME_MAX_LENGTH}
          name="fullName"
          placeholder="Your name"
          required
        />
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
        <PasswordField
          autoComplete="new-password"
          error={state.fieldErrors?.password}
          hint={<PasswordChecklist password={password} />}
          label="Password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Create a password"
          required
          value={password}
        />
        <PasswordField
          autoComplete="new-password"
          error={state.fieldErrors?.confirmPassword}
          label="Confirm password"
          name="confirmPassword"
          placeholder="Repeat your password"
          required
        />
        <SubmitButton pending={pending} pendingLabel="Creating your account…">Create Account</SubmitButton>
        <p className="auth-terms">By creating an account you agree to Ari&apos;s Terms of Service and Privacy Policy.</p>
      </form>

      <p className="auth-switch">
        Already have an account? <Link href="/login">Sign In</Link>
      </p>
    </>
  );
}

export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="password-rules">
      {passwordRules.map((rule) => (
        <li className={password && rule.test(password) ? "met" : undefined} key={rule.id}>
          {rule.label}
        </li>
      ))}
    </ul>
  );
}

function CheckEmail({ email }: { email: string }) {
  const [state, action, pending] = useActionState(resendVerification, initialState);

  return (
    <div className="auth-status">
      <div aria-hidden="true" className="auth-status-icon">✉</div>
      <h1>Check your email</h1>
      <p>We sent a verification link to your email address.</p>
      <p className="auth-status-email">{email}</p>
      <p className="auth-status-note">Open the link to verify your account. It may take a minute, and it can land in spam.</p>

      {state.message && <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage>}

      <form action={action}>
        <input name="email" type="hidden" value={email} />
        <button aria-busy={pending} className="auth-secondary" disabled={pending} type="submit">
          {pending && <span aria-hidden="true" className="spinner dark" />}
          {pending ? "Sending…" : "Resend verification email"}
        </button>
      </form>
      <Link className="auth-back" href="/login">← Return to login</Link>
    </div>
  );
}
