"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resendVerification, signIn, signInWithGoogle, type AuthFormState } from "@/app/(auth)/actions";
import { FormMessage, PasswordField, SubmitButton, TextField } from "./form-fields";

const initialState: AuthFormState = { status: "idle" };

type Props = {
  next?: string;
  notice?: { tone: "success" | "error" | "info"; text: string };
  googleEnabled: boolean;
};

export function LoginForm({ next, notice, googleEnabled }: Props) {
  const [state, action, pending] = useActionState(signIn, initialState);
  const [resendState, resendAction, resendPending] = useActionState(resendVerification, initialState);

  return (
    <>
      {state.status === "idle" && notice && <FormMessage tone={notice.tone}>{notice.text}</FormMessage>}
      {state.message && <FormMessage tone="error">{state.message}</FormMessage>}

      {state.unverifiedEmail && (
        <form action={resendAction} className="inline-resend">
          <input name="email" type="hidden" value={state.unverifiedEmail} />
          {resendState.message ? (
            <FormMessage tone={resendState.status === "error" ? "error" : "success"}>{resendState.message}</FormMessage>
          ) : (
            <button className="link-button" disabled={resendPending} type="submit">
              {resendPending ? "Sending…" : "Resend verification email"}
            </button>
          )}
        </form>
      )}

      <form action={action} className="auth-form" noValidate>
        {next && <input name="next" type="hidden" value={next} />}
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
          autoComplete="current-password"
          error={state.fieldErrors?.password}
          label="Password"
          labelAction={<Link className="field-link" href="/forgot-password">Forgot password?</Link>}
          name="password"
          placeholder="Your password"
          required
        />
        <label className="checkbox-row">
          <input defaultChecked name="remember" type="checkbox" />
          <span>Keep me signed in on this device</span>
        </label>
        <SubmitButton pending={pending} pendingLabel="Signing in…">Sign In</SubmitButton>
      </form>

      {googleEnabled && (
        <>
          <div className="auth-divider"><span>or</span></div>
          <form action={signInWithGoogle}>
            {next && <input name="next" type="hidden" value={next} />}
            <button className="oauth-button" type="submit">
              <GoogleIcon />
              Continue with Google
            </button>
          </form>
        </>
      )}

      <p className="auth-switch">
        New to Ari? <Link href="/signup">Create Account</Link>
      </p>
    </>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 24 24" width="16">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" fill="#34A853" />
      <path d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" fill="#EA4335" />
    </svg>
  );
}
