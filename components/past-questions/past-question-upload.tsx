"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { registerPastQuestionSet } from "@/app/(app)/past-questions/actions";
import { useAuth } from "@/components/auth/auth-provider";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { MATERIALS_BUCKET } from "@/lib/library/config";
import { buildMaterialPath, formatFileSize, getFileExtension, MAX_FILE_SIZE_LABEL, sniffFileType, titleFromFilename, toSafeStorageName, validateMaterialFile } from "@/lib/library/files";
import type { SubjectOption } from "@/lib/library/types";
import { UploadError, uploadToStorage } from "@/lib/library/upload";
import { PAST, PAST_QUESTION_ACCEPT, PAST_QUESTION_TYPES_LABEL } from "@/lib/past-questions/config";
import { createClient } from "@/lib/supabase/client";

type Phase = { name: "idle" } | { name: "uploading"; progress: number } | { name: "saving" } | { name: "error"; message: string };

type Props = { subjects: SubjectOption[]; onClose: () => void; onUploaded: () => void };

const EMPTY = { title: "", examType: "", institution: "", year: "", courseCode: "", description: "" };

// Uploads a past paper into the same private storage study materials use,
// then records it as a past-question collection. Only the subject and the
// file are required; every other detail is optional.
export function PastQuestionUpload({ subjects, onClose, onUploaded }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const abortController = useRef<AbortController | null>(null);
  const [subjectId, setSubjectId] = useState(subjects.length === 1 ? subjects[0].id : "");
  const [file, setFile] = useState<File | null>(null);
  const [details, setDetails] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  const busy = phase.name === "uploading" || phase.name === "saving";

  // Stop an in-flight upload if the dialog goes away.
  useEffect(() => () => abortController.current?.abort(), []);

  const set = (field: keyof typeof EMPTY) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDetails((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  // The same checks as any upload, plus one: photos and scans are refused
  // here because there is nothing yet that can read them.
  const check = (chosen: File) => {
    const result = validateMaterialFile(chosen);
    if (!result.ok) return result;
    if (result.type.kind !== "document") return { ok: false as const, error: `Photos and scans can't be read yet. Upload one of: ${PAST_QUESTION_TYPES_LABEL}.` };
    return result;
  };

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen || busy) return;
    const result = check(chosen);
    setPhase({ name: "idle" });
    setFile(result.ok ? chosen : null);
    setErrors((current) => ({ ...current, file: result.ok ? undefined : result.error }));
    if (result.ok && !details.title) setDetails((current) => ({ ...current, title: titleFromFilename(chosen.name) }));
  };

  const upload = async () => {
    if (busy) return;
    const result = file ? check(file) : null;
    const problems = {
      subject: subjectId ? undefined : "Choose the subject these questions belong to.",
      file: !file ? "Choose a file to upload." : result && !result.ok ? result.error : undefined,
    };
    if (problems.subject || problems.file || !file || !result?.ok) {
      setErrors((current) => ({ ...current, ...problems }));
      return;
    }

    setPhase({ name: "uploading", progress: 0 });
    const supabase = createClient();
    const controller = new AbortController();
    abortController.current = controller;

    // A fresh id per attempt, so a retry can never collide with an earlier one.
    const setId = crypto.randomUUID();
    const storageName = toSafeStorageName(file.name, getFileExtension(file.name));
    const path = buildMaterialPath(user.id, subjectId, setId, storageName);
    let uploaded = false;

    try {
      if (!(await sniffFileType(file, result.type))) {
        setPhase({ name: "error", message: `This doesn't look like a real ${result.type.label} file. It may be damaged or renamed.` });
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setPhase({ name: "error", message: "Your session has expired. Please sign in again." });
        return;
      }

      await uploadToStorage({
        path,
        file,
        contentType: result.type.mimeType,
        accessToken: data.session.access_token,
        signal: controller.signal,
        onProgress: (progress) => setPhase({ name: "uploading", progress }),
      });
      uploaded = true;

      setPhase({ name: "saving" });
      const saved = await registerPastQuestionSet({ setId, subjectId, storageName, originalFilename: file.name, ...details });
      if (!saved.ok) {
        // The server has already removed the file in this case.
        setErrors((current) => ({ ...current, ...saved.fieldErrors }));
        setPhase({ name: "error", message: saved.error });
        return;
      }

      toast("Past questions uploaded. Ari is reading them now.");
      onUploaded();
      onClose();
    } catch (error) {
      // The file may be in storage with no database row. Remove it.
      if (uploaded) await supabase.storage.from(MATERIALS_BUCKET).remove([path]).catch(() => undefined);
      if (error instanceof UploadError && error.aborted) {
        setPhase({ name: "idle" });
        return;
      }
      setPhase({ name: "error", message: error instanceof UploadError ? error.message : "We couldn't upload this file. Please try again." });
    } finally {
      abortController.current = null;
    }
  };

  if (subjects.length === 0) {
    return (
      <Dialog onClose={onClose} title="Upload past questions">
        <div className="dialog-body">
          <p>Past questions are kept with the subject they belong to. Create a subject first, then upload your past papers into it.</p>
        </div>
        <div className="dialog-actions">
          <button className="auth-secondary" onClick={onClose} type="button">Cancel</button>
          <Link className="auth-submit" href="/subjects">Go to subjects</Link>
        </div>
      </Dialog>
    );
  }

  const text = (field: keyof typeof EMPTY, label: string, placeholder: string, maxLength: number, optional = true) => (
    <div className="field">
      <label htmlFor={`pq-${field}`}>{label}{optional && <span className="optional">optional</span>}</label>
      <input
        aria-invalid={errors[field] ? true : undefined}
        className={`field-input${errors[field] ? " has-error" : ""}`}
        disabled={busy}
        id={`pq-${field}`}
        inputMode={field === "year" ? "numeric" : undefined}
        maxLength={maxLength}
        onChange={set(field)}
        placeholder={placeholder}
        type="text"
        value={details[field]}
      />
      {errors[field] && <p className="field-error" role="alert">{errors[field]}</p>}
    </div>
  );

  return (
    <Dialog busy={busy} description="Only the subject and the file are needed. The rest helps you find and filter them later." onClose={onClose} title="Upload past questions">
      <div className="auth-form">
        <div className="field">
          <label htmlFor="pq-subject">Subject</label>
          <select
            aria-invalid={errors.subject ? true : undefined}
            className={`field-input${errors.subject ? " has-error" : ""}`}
            disabled={busy}
            id="pq-subject"
            onChange={(event) => {
              setSubjectId(event.target.value);
              setErrors((current) => ({ ...current, subject: undefined }));
            }}
            value={subjectId}
          >
            <option value="">Select a subject</option>
            {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
          </select>
          {errors.subject && <p className="field-error" role="alert">{errors.subject}</p>}
        </div>

        <div className="field">
          <span className="field-label">File</span>
          {file ? (
            <div className="upload-file">
              <span aria-hidden="true" className="file-chip">{getFileExtension(file.name).toUpperCase()}</span>
              <span className="upload-file-copy"><strong>{file.name}</strong><span>{formatFileSize(file.size)}</span></span>
              {!busy && <button className="link-button" onClick={() => setFile(null)} type="button">Remove</button>}
            </div>
          ) : (
            <button className={`upload-dropzone dialog-dropzone${errors.file ? " has-error" : ""}`} onClick={() => fileInput.current?.click()} type="button">
              <strong>Choose a past paper</strong>
              <span>{PAST_QUESTION_TYPES_LABEL}</span>
              <span className="file-types">Up to {MAX_FILE_SIZE_LABEL}. Text-based files only: scanned or photographed papers can&apos;t be read yet.</span>
            </button>
          )}
          <input accept={PAST_QUESTION_ACCEPT} aria-label="Choose a past paper to upload" className="visually-hidden" onChange={chooseFile} ref={fileInput} type="file" />
          {errors.file && <p className="field-error" role="alert">{errors.file}</p>}
        </div>

        {text("title", "Title", "e.g. Anatomy Past Questions 2021–2025", PAST.titleMaxLength, false)}
        <div className="practice-row">
          {text("examType", "Exam", "e.g. WAEC, Final exam", PAST.examTypeMaxLength)}
          {text("year", "Year", "e.g. 2024", 4)}
        </div>
        <div className="practice-row">
          {text("institution", "Institution or board", "e.g. University of Lagos", PAST.institutionMaxLength)}
          {text("courseCode", "Course code", "e.g. ANA 201", PAST.courseCodeMaxLength)}
        </div>
        <div className="field">
          <label htmlFor="pq-description">Notes<span className="optional">optional</span></label>
          <textarea className="field-input field-textarea" disabled={busy} id="pq-description" maxLength={PAST.descriptionMaxLength} onChange={set("description")} rows={2} value={details.description} />
          {errors.description && <p className="field-error" role="alert">{errors.description}</p>}
        </div>

        {busy && (
          <div className="upload-progress">
            <div aria-label="Upload progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={phase.name === "uploading" ? Math.round(phase.progress * 100) : 100} className="progress-track" role="progressbar">
              <span style={{ width: `${phase.name === "uploading" ? Math.round(phase.progress * 100) : 100}%` }} />
            </div>
            <span>{phase.name === "uploading" ? `Uploading… ${Math.round(phase.progress * 100)}%` : "Saving your collection…"}</span>
          </div>
        )}
        {phase.name === "error" && <div className="form-message error" role="alert">{phase.message}</div>}

        <div className="dialog-actions">
          {phase.name === "uploading" ? (
            <button className="auth-secondary" onClick={() => abortController.current?.abort()} type="button">Cancel upload</button>
          ) : (
            <button className="auth-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
          )}
          <button aria-busy={busy} className="auth-submit" disabled={busy} onClick={upload} type="button">
            {busy && <span aria-hidden="true" className="spinner" />}
            {busy ? "Uploading…" : phase.name === "error" ? "Try again" : "Upload"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
