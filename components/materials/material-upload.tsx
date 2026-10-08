"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { registerMaterial } from "@/app/(app)/materials/actions";
import { useAuth } from "@/components/auth/auth-provider";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { MATERIAL_ACCEPT, MATERIALS_BUCKET, SUPPORTED_TYPES_LABEL } from "@/lib/library/config";
import {
  buildMaterialPath,
  formatFileSize,
  getFileExtension,
  MAX_FILE_SIZE_LABEL,
  sniffFileType,
  toSafeStorageName,
  validateMaterialFile,
} from "@/lib/library/files";
import type { SubjectOption } from "@/lib/library/types";
import { UploadError, uploadToStorage } from "@/lib/library/upload";
import { createClient } from "@/lib/supabase/client";

type Phase =
  | { name: "idle" }
  | { name: "uploading"; progress: number }
  | { name: "saving" }
  | { name: "success"; title: string }
  | { name: "error"; message: string; canRetry: boolean };

type Props = {
  subjects: SubjectOption[];
  // Preselects (and, on a subject page, fixes) the destination.
  subjectId?: string;
  onClose: () => void;
};

export function MaterialUpload({ subjects, subjectId: initialSubjectId, onClose }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const abortController = useRef<AbortController | null>(null);
  const [subjectId, setSubjectId] = useState(initialSubjectId ?? (subjects.length === 1 ? subjects[0].id : ""));
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  const busy = phase.name === "uploading" || phase.name === "saving";

  // Stop an in-flight upload if the dialog goes away.
  useEffect(() => () => abortController.current?.abort(), []);

  const chooseFile = (chosen: File | undefined) => {
    if (!chosen || busy) return;
    const check = validateMaterialFile(chosen);
    setPhase({ name: "idle" });
    setFile(check.ok ? chosen : null);
    setFileError(check.ok ? null : check.error);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setFileError("Upload one file at a time.");
      return;
    }
    chooseFile(event.dataTransfer.files[0]);
  };

  const upload = async () => {
    if (busy) return;
    if (!subjectId) {
      setSubjectError("Choose a subject for this material.");
      return;
    }
    if (!file) {
      setFileError("Choose a file to upload.");
      return;
    }

    const check = validateMaterialFile(file);
    if (!check.ok) {
      setFileError(check.error);
      return;
    }

    setPhase({ name: "uploading", progress: 0 });
    const supabase = createClient();
    const controller = new AbortController();
    abortController.current = controller;

    // A fresh id per attempt, so a retry can never collide with a
    // half-finished earlier attempt.
    const materialId = crypto.randomUUID();
    const storageName = toSafeStorageName(file.name, getFileExtension(file.name));
    const path = buildMaterialPath(user.id, subjectId, materialId, storageName);
    let uploaded = false;

    try {
      if (!(await sniffFileType(file, check.type))) {
        setPhase({ name: "error", canRetry: false, message: `This doesn't look like a real ${check.type.label} file. It may be damaged or renamed.` });
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setPhase({ name: "error", canRetry: false, message: "Your session has expired. Please sign in again." });
        return;
      }

      await uploadToStorage({
        path,
        file,
        contentType: check.type.mimeType,
        accessToken: data.session.access_token,
        signal: controller.signal,
        onProgress: (progress) => setPhase({ name: "uploading", progress }),
      });
      uploaded = true;

      setPhase({ name: "saving" });
      const result = await registerMaterial({ materialId, subjectId, storageName, originalFilename: file.name });
      if (!result.ok) {
        // The server has already removed the file in this case.
        setPhase({ name: "error", canRetry: true, message: result.error });
        return;
      }

      setPhase({ name: "success", title: file.name });
      toast("Material uploaded.");
    } catch (error) {
      // The file may be in storage with no database row (for example the
      // connection dropped before it could be registered). Remove it.
      if (uploaded) await supabase.storage.from(MATERIALS_BUCKET).remove([path]).catch(() => undefined);

      if (error instanceof UploadError && error.aborted) {
        setPhase({ name: "idle" });
        return;
      }
      setPhase({
        name: "error",
        canRetry: true,
        message: error instanceof UploadError ? error.message : "We couldn't add the file to your library. Please try again.",
      });
    } finally {
      abortController.current = null;
    }
  };

  const reset = () => {
    setFile(null);
    setFileError(null);
    setPhase({ name: "idle" });
  };

  if (subjects.length === 0) {
    return (
      <Dialog onClose={onClose} title="Upload study material">
        <div className="dialog-body">
          <p>Materials live inside subjects. Create a subject first, then upload your notes, slides and PDFs into it.</p>
        </div>
        <div className="dialog-actions">
          <button className="auth-secondary" onClick={onClose} type="button">Cancel</button>
          <Link className="auth-submit" href="/subjects">Go to subjects</Link>
        </div>
      </Dialog>
    );
  }

  if (phase.name === "success") {
    return (
      <Dialog onClose={onClose} title="Upload complete">
        <div className="upload-result">
          <div aria-hidden="true" className="auth-status-icon">✓</div>
          <strong>{phase.title}</strong>
          <p>Saved to your library. It&apos;s waiting for processing, which arrives in a later update.</p>
        </div>
        <div className="dialog-actions">
          <button className="auth-secondary" onClick={reset} type="button">Upload another</button>
          <button className="auth-submit" onClick={onClose} type="button">Done</button>
        </div>
      </Dialog>
    );
  }

  const lockedSubject = initialSubjectId ? subjects.find((subject) => subject.id === initialSubjectId) : undefined;

  return (
    <Dialog busy={busy} onClose={onClose} title="Upload study material">
      <div className="auth-form">
        <div className="field">
          <div className="field-label-row"><label htmlFor="upload-subject">Subject</label></div>
          {lockedSubject ? (
            <input className="field-input" id="upload-subject" readOnly value={lockedSubject.name} />
          ) : (
            <select
              aria-invalid={subjectError ? true : undefined}
              className={`field-input${subjectError ? " has-error" : ""}`}
              disabled={busy}
              id="upload-subject"
              onChange={(event) => {
                setSubjectId(event.target.value);
                setSubjectError(null);
              }}
              value={subjectId}
            >
              <option value="">Select a subject</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>{subject.name}</option>
              ))}
            </select>
          )}
          {subjectError && <p className="field-error" role="alert">{subjectError}</p>}
        </div>

        <div className="field">
          <div className="field-label-row"><span className="field-label">File</span></div>
          {file ? (
            <div className="upload-file">
              <span aria-hidden="true" className="file-chip">{getFileExtension(file.name).toUpperCase()}</span>
              <span className="upload-file-copy">
                <strong>{file.name}</strong>
                <span>{formatFileSize(file.size)}</span>
              </span>
              {!busy && <button className="link-button" onClick={reset} type="button">Remove</button>}
            </div>
          ) : (
            <button
              className={`upload-dropzone dialog-dropzone${dragging ? " dragging" : ""}${fileError ? " has-error" : ""}`}
              onClick={() => fileInput.current?.click()}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDrop={handleDrop}
              type="button"
            >
              <strong>Drag &amp; drop or browse</strong>
              <span>{SUPPORTED_TYPES_LABEL}</span>
              <span className="file-types">Maximum file size: {MAX_FILE_SIZE_LABEL}</span>
            </button>
          )}
          <input
            accept={MATERIAL_ACCEPT}
            aria-label="Choose a file to upload"
            className="visually-hidden"
            onChange={handleInput}
            ref={fileInput}
            type="file"
          />
          {fileError && <p className="field-error" role="alert">{fileError}</p>}
        </div>

        {busy && (
          <div className="upload-progress">
            <div
              aria-label="Upload progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={phase.name === "uploading" ? Math.round(phase.progress * 100) : 100}
              className="progress-track"
              role="progressbar"
            >
              <span style={{ width: `${phase.name === "uploading" ? Math.round(phase.progress * 100) : 100}%` }} />
            </div>
            <span>{phase.name === "uploading" ? `Uploading… ${Math.round(phase.progress * 100)}%` : "Adding to your library…"}</span>
          </div>
        )}

        {phase.name === "error" && <div className="form-message error" role="alert">{phase.message}</div>}

        <div className="dialog-actions">
          {phase.name === "uploading" ? (
            <button className="auth-secondary" onClick={() => abortController.current?.abort()} type="button">Cancel upload</button>
          ) : (
            <button className="auth-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
          )}
          <button aria-busy={busy} className="auth-submit" disabled={busy || (phase.name === "error" && !phase.canRetry)} onClick={upload} type="button">
            {busy && <span aria-hidden="true" className="spinner" />}
            {busy ? "Uploading…" : phase.name === "error" && phase.canRetry ? "Try again" : "Upload"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
