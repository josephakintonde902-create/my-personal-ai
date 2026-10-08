"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

type Props = {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  // While true the dialog cannot be dismissed (an operation is in flight).
  busy?: boolean;
  children: ReactNode;
};

// Modal built on the native <dialog> element, which provides the focus trap,
// Escape handling, and inert background. Mount it to open, unmount to close.
export function Dialog({ title, description, onClose, busy = false, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === ref.current && !busy) onClose();
      }}
      ref={ref}
    >
      <div className="dialog-panel">
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button aria-label="Close" className="dialog-close" disabled={busy} onClick={onClose} type="button">×</button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

type ConfirmProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, pending, error, onConfirm, onClose }: ConfirmProps) {
  return (
    <Dialog busy={pending} onClose={onClose} title={title}>
      <div className="dialog-body">{children}</div>
      {error && <div className="form-message error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="auth-secondary" disabled={pending} onClick={onClose} type="button">Cancel</button>
        <button aria-busy={pending} className="auth-submit danger" disabled={pending} onClick={onConfirm} type="button">
          {pending && <span aria-hidden="true" className="spinner" />}
          {pending ? pendingLabel : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
