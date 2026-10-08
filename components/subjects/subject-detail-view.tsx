"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MaterialList } from "@/components/materials/material-list";
import { MaterialUpload } from "@/components/materials/material-upload";
import { formatDate, materialCountLabel } from "@/lib/library/format";
import type { StudyMaterial, SubjectWithCount } from "@/lib/library/types";
import { DeleteSubjectDialog } from "./delete-subject-dialog";
import { SubjectBadge } from "./subject-badge";
import { SubjectFormDialog } from "./subject-form-dialog";

type Props = { subject: SubjectWithCount; materials: StudyMaterial[]; processingEnabled: boolean };

export function SubjectDetailView({ subject, materials, processingEnabled }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"upload" | "edit" | "delete" | null>(null);
  const close = () => setDialog(null);

  return (
    <>
      <Link className="back-link" href="/subjects">← Back to subjects</Link>

      <div className="subject-header">
        <SubjectBadge color={subject.color} icon={subject.icon} name={subject.name} size="lg" />
        <div className="subject-header-copy">
          <h1>{subject.name}</h1>
          {subject.description && <p className="subject-header-description">{subject.description}</p>}
          <p className="subject-card-meta">
            {materialCountLabel(materials.length)} <i>·</i> Created {formatDate(subject.created_at)}
          </p>
        </div>
        <div className="subject-header-actions">
          <button className="action-button" onClick={() => setDialog("upload")} type="button">
            <span aria-hidden="true">↑</span> Upload material
          </button>
          <Link className="icon-button primary" href={`/tutor?subject=${subject.id}`}>Ask Ari</Link>
          <button className="icon-button" onClick={() => setDialog("edit")} type="button">Edit</button>
          <button className="icon-button danger" onClick={() => setDialog("delete")} type="button">Delete</button>
        </div>
      </div>

      <div className="section-heading lower-heading">
        <div><span className="section-icon library-icon">▤</span><h2>Study materials</h2></div>
      </div>

      {materials.length === 0 ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>✳</span><i>·</i></div>
          <strong>No study materials yet.</strong>
          <p>Upload your notes, slides, PDFs, and other study materials so Ari can use them later.</p>
          <button className="action-button" onClick={() => setDialog("upload")} type="button">
            <span aria-hidden="true">↑</span> Upload material
          </button>
        </div>
      ) : (
        <MaterialList materials={materials} processingEnabled={processingEnabled} />
      )}

      {dialog === "upload" && <MaterialUpload onClose={close} subjectId={subject.id} subjects={[subject]} />}
      {dialog === "edit" && <SubjectFormDialog onClose={close} subject={subject} />}
      {dialog === "delete" && (
        <DeleteSubjectDialog
          onClose={close}
          onDeleted={() => router.replace("/subjects")}
          subject={{ ...subject, material_count: materials.length }}
        />
      )}
    </>
  );
}
