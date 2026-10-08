"use client";

import { useState, useTransition } from "react";
import { deleteSubject } from "@/app/(app)/subjects/actions";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { materialCountLabel } from "@/lib/library/format";
import type { SubjectWithCount } from "@/lib/library/types";

type Props = { subject: SubjectWithCount; onClose: () => void; onDeleted?: () => void };

export function DeleteSubjectDialog({ subject, onClose, onDeleted }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteSubject(subject.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast(`“${subject.name}” deleted.`);
      onDeleted?.();
      onClose();
    });
  };

  return (
    <ConfirmDialog
      confirmLabel="Delete subject"
      error={error}
      onClose={onClose}
      onConfirm={handleConfirm}
      pending={pending}
      pendingLabel="Deleting…"
      title={`Delete “${subject.name}”?`}
    >
      <p>
        {subject.material_count > 0 ? (
          <>This will permanently delete the subject and its <strong>{materialCountLabel(subject.material_count)}</strong>, including the uploaded files.</>
        ) : (
          <>This will permanently delete the subject. It has no study materials.</>
        )}
      </p>
      <p>This can&apos;t be undone.</p>
    </ConfirmDialog>
  );
}
