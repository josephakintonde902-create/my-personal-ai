"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDate, materialCountLabel } from "@/lib/library/format";
import type { SubjectWithCount } from "@/lib/library/types";
import { DeleteSubjectDialog } from "./delete-subject-dialog";
import { SubjectBadge } from "./subject-badge";
import { SubjectFormDialog } from "./subject-form-dialog";

type DialogState =
  | { type: "create" }
  | { type: "edit"; subject: SubjectWithCount }
  | { type: "delete"; subject: SubjectWithCount }
  | null;

export function SubjectsView({ subjects }: { subjects: SubjectWithCount[] }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> YOUR LIBRARY</p>
          <h1>My subjects<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Organize your study materials by subject.</p>
        </div>
        {subjects.length > 0 && (
          <button className="action-button" onClick={() => setDialog({ type: "create" })} type="button">
            <span aria-hidden="true">+</span> New subject
          </button>
        )}
      </div>

      {subjects.length === 0 ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>▤</span><i>·</i></div>
          <strong>No subjects yet.</strong>
          <p>Create your first subject to organize your study materials.</p>
          <button className="action-button" onClick={() => setDialog({ type: "create" })} type="button">
            <span aria-hidden="true">+</span> Create subject
          </button>
        </div>
      ) : (
        <ul className="subject-grid">
          {subjects.map((subject) => (
            <li className="subject-card" key={subject.id}>
              <Link className="subject-card-link" href={`/subjects/${subject.id}`}>
                <SubjectBadge color={subject.color} icon={subject.icon} name={subject.name} />
                <span className="subject-card-copy">
                  <strong>{subject.name}</strong>
                  <span className="subject-card-description">{subject.description ?? "No description"}</span>
                </span>
                <span className="subject-card-meta">
                  {materialCountLabel(subject.material_count)} <i>·</i> Created {formatDate(subject.created_at)}
                </span>
              </Link>
              <div className="card-actions">
                <button aria-label={`Edit ${subject.name}`} className="icon-button" onClick={() => setDialog({ type: "edit", subject })} type="button">Edit</button>
                <button aria-label={`Delete ${subject.name}`} className="icon-button danger" onClick={() => setDialog({ type: "delete", subject })} type="button">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {dialog?.type === "create" && <SubjectFormDialog onClose={close} />}
      {dialog?.type === "edit" && <SubjectFormDialog onClose={close} subject={dialog.subject} />}
      {dialog?.type === "delete" && <DeleteSubjectDialog onClose={close} subject={dialog.subject} />}
    </>
  );
}
