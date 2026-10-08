"use client";

import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  error?: string;
  hint?: ReactNode;
  labelAction?: ReactNode;
};

export function TextField({ label, error, hint, labelAction, ...input }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        {labelAction}
      </div>
      <input
        {...input}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`field-input${error ? " has-error" : ""}`}
        id={id}
      />
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">{error}</p>
      ) : hint ? (
        <div className="field-hint" id={`${id}-hint`}>{hint}</div>
      ) : null}
    </div>
  );
}

export function PasswordField({ label, error, hint, labelAction, ...input }: FieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id}>{label}</label>
        {labelAction}
      </div>
      <div className="password-wrap">
        <input
          {...input}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`field-input${error ? " has-error" : ""}`}
          id={id}
          type={visible ? "text" : "password"}
        />
        <button
          aria-controls={id}
          aria-pressed={visible}
          className="password-toggle"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? "Hide" : "Show"}
          <span className="visually-hidden"> password</span>
        </button>
      </div>
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">{error}</p>
      ) : hint ? (
        <div className="field-hint" id={`${id}-hint`}>{hint}</div>
      ) : null}
    </div>
  );
}

export function SubmitButton({ pending, pendingLabel, children }: { pending: boolean; pendingLabel: string; children: ReactNode }) {
  return (
    <button aria-busy={pending} className="auth-submit" disabled={pending} type="submit">
      {pending && <span aria-hidden="true" className="spinner" />}
      {pending ? pendingLabel : children}
    </button>
  );
}

export function FormMessage({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`form-message ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
