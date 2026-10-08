"use client";

import { useState, useTransition, type FormEvent } from "react";
import { deleteMaterial, renameMaterial } from "@/app/(app)/materials/actions";
import { TextField } from "@/components/auth/form-fields";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { MATERIAL_TITLE_MAX_LENGTH } from "@/lib/library/config";
import type { StudyMaterial } from "@/lib/library/types";

type Props = { material: StudyMaterial; onClose: () => void };

export function RenameMaterialDialog({ material, onClose }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState(material.title);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!title.trim()) {
      setError("Give this material a title.");
      return;
    }
    if (title.trim() === material.title) {
      onClose();
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await renameMaterial(material.id, title);
      if (!result.ok) {
        setError(result.fieldErrors?.title ?? result.error);
        return;
      }
      toast("Material renamed.");
      onClose();
    });
  };

  return (
    <Dialog
      busy={pending}
      description={<>The file itself keeps its original name: <span className="break-anywhere">{material.original_filename}</span></>}
      onClose={onClose}
      title="Rename material"
    >
      <form className="auth-form" noValidate onSubmit={handleSubmit}>
        <TextField
          autoComplete="off"
          autoFocus
          error={error ?? undefined}
          label="Title"
          maxLength={MATERIAL_TITLE_MAX_LENGTH}
          name="title"
          onChange={(event) => setTitle(event.target.value)}
          required
          value={title}
        />
        <div className="dialog-actions">
          <button className="auth-secondary" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <button aria-busy={pending} className="auth-submit" disabled={pending} type="submit">
            {pending && <span aria-hidden="true" className="spinner" />}
            {pending ? "Saving…" : "Save title"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeleteMaterialDialog({ material, onClose }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteMaterial(material.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast("Material deleted.");
      onClose();
    });
  };

  return (
    <ConfirmDialog
      confirmLabel="Delete material"
      error={error}
      onClose={onClose}
      onConfirm={handleConfirm}
      pending={pending}
      pendingLabel="Deleting…"
      title="Delete this material?"
    >
      <p><strong className="break-anywhere">{material.title}</strong> and its uploaded file will be permanently deleted.</p>
      <p>This can&apos;t be undone.</p>
    </ConfirmDialog>
  );
}
