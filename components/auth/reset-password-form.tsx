"use client";

import { useActionState, useState } from "react";
import { updatePassword, type AuthFormState } from "@/app/(auth)/actions";
import { FormMessage, PasswordField, SubmitButton } from "./form-fields";
import { PasswordChecklist } from "./signup-form";

const initialState: AuthFormState = { status: "idle" };

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, initialState);
  const [password, setPassword] = useState("");

  return (
    <>
      {state.message && <FormMessage tone="error">{state.message}</FormMessage>}

      <form action={action} className="auth-form" noValidate>
        <PasswordField
          autoComplete="new-password"
          error={state.fieldErrors?.password}
          hint={<PasswordChecklist password={password} />}
          label="New password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Create a new password"
          required
          value={password}
        />
        <PasswordField
          autoComplete="new-password"
          error={state.fieldErrors?.confirmPassword}
          label="Confirm new password"
          name="confirmPassword"
          placeholder="Repeat your new password"
          required
        />
        <SubmitButton pending={pending} pendingLabel="Updating password…">Update password</SubmitButton>
      </form>
    </>
  );
}
