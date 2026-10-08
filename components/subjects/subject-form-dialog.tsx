"use client";

import { useState, useTransition, type FormEvent } from "react";
import { createSubject, updateSubject } from "@/app/(app)/subjects/actions";
import { TextField } from "@/components/auth/form-fields";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  DEFAULT_SUBJECT_COLOR,
  SUBJECT_COLORS,
  SUBJECT_DESCRIPTION_MAX_LENGTH,
  SUBJECT_ICONS,
  SUBJECT_NAME_MAX_LENGTH,
} from "@/lib/library/config";
import type { Subject } from "@/lib/library/types";

type Props = {
  // Present when editing; absent when creating.
  subject?: Subject;
  onClose: () => void;
  onCreated?: (id: string) => void;
};

export function SubjectFormDialog({ subject, onClose, onCreated }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(subject?.name ?? "");
  const [description, setDescription] = useState(subject?.description ?? "");
  const [color, setColor] = useState(subject?.color ?? DEFAULT_SUBJECT_COLOR);
  const [icon, setIcon] = useState(subject?.icon ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;

    if (!name.trim()) {
      setFieldErrors({ name: "Give your subject a name." });
      return;
    }

    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const input = { name, description, color, icon };
      const result = subject ? await updateSubject(subject.id, input) : await createSubject(input);

      if (!result.ok) {
        setFieldErrors(result.fieldErrors ?? {});
        setError(result.fieldErrors ? null : result.error);
        return;
      }

      toast(subject ? "Subject updated." : `“${name.trim()}” created.`);
      if (!subject && result.data) onCreated?.(result.data.id);
      onClose();
    });
  };

  return (
    <Dialog
      busy={pending}
      description={subject ? undefined : "Subjects keep related study materials together."}
      onClose={onClose}
      title={subject ? "Edit subject" : "New subject"}
    >
      <form className="auth-form" noValidate onSubmit={handleSubmit}>
        {error && <div className="form-message error" role="alert">{error}</div>}

        <TextField
          autoComplete="off"
          autoFocus
          error={fieldErrors.name}
          label="Subject name"
          maxLength={SUBJECT_NAME_MAX_LENGTH}
          name="name"
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Mathematics"
          required
          value={name}
        />

        <div className="field">
          <div className="field-label-row">
            <label htmlFor="subject-description">Description <span className="optional">Optional</span></label>
            <span className="field-count">{description.length}/{SUBJECT_DESCRIPTION_MAX_LENGTH}</span>
          </div>
          <textarea
            aria-invalid={fieldErrors.description ? true : undefined}
            className={`field-input field-textarea${fieldErrors.description ? " has-error" : ""}`}
            id="subject-description"
            maxLength={SUBJECT_DESCRIPTION_MAX_LENGTH}
            name="description"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does this subject cover?"
            rows={3}
            value={description}
          />
          {fieldErrors.description && <p className="field-error" role="alert">{fieldErrors.description}</p>}
        </div>

        <fieldset className="choice-group">
          <legend>Color</legend>
          <div className="swatch-row">
            {SUBJECT_COLORS.map((option) => (
              <label className={`swatch tone-${option.id}`} key={option.id} title={option.label}>
                <input checked={color === option.id} name="color" onChange={() => setColor(option.id)} type="radio" value={option.id} />
                <span className="visually-hidden">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice-group">
          <legend>Icon <span className="optional">Optional</span></legend>
          <div className="icon-row">
            <label className="icon-choice" title="No icon: show the subject's initial">
              <input checked={icon === ""} name="icon" onChange={() => setIcon("")} type="radio" value="" />
              <span aria-hidden="true">{(name.trim()[0] ?? "A").toUpperCase()}</span>
              <span className="visually-hidden">No icon</span>
            </label>
            {SUBJECT_ICONS.map((option) => (
              <label className="icon-choice" key={option.id} title={option.label}>
                <input checked={icon === option.id} name="icon" onChange={() => setIcon(option.id)} type="radio" value={option.id} />
                <span aria-hidden="true">{option.glyph}</span>
                <span className="visually-hidden">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="dialog-actions">
          <button className="auth-secondary" disabled={pending} onClick={onClose} type="button">Cancel</button>
          <button aria-busy={pending} className="auth-submit" disabled={pending} type="submit">
            {pending && <span aria-hidden="true" className="spinner" />}
            {pending ? "Saving…" : subject ? "Save changes" : "Create subject"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
