"use client";

import type { SubjectOption } from "@/lib/library/types";

// A processed study material the student can practise from. `kind` is its
// file type label ("PDF", "PPTX", "DOCX", ...).
export type MaterialOption = { id: string; title: string; subjectId: string; kind: string };

// What a quiz or deck is made from. Empty strings mean "all".
export type Scope = { subjectId: string; materialId: string; topic: string };

export const EMPTY_SCOPE: Scope = { subjectId: "", materialId: "", topic: "" };

type Props = {
  // Makes the field ids unique when two forms are on one page.
  idPrefix: string;
  subjects: SubjectOption[];
  materials: MaterialOption[];
  value: Scope;
  onChange: (scope: Scope) => void;
  disabled?: boolean;
  topicMaxLength: number;
};

// Subject, material and optional focus: the same three choices for quizzes
// and for flashcards. Every kind of material appears in one list; a
// PowerPoint is chosen exactly like a PDF.
export function ScopeFields({ idPrefix, subjects, materials, value, onChange, disabled, topicMaxLength }: Props) {
  const inSubject = value.subjectId ? materials.filter((material) => material.subjectId === value.subjectId) : materials;

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-subject`}>Subject</label>
        <select
          className="field-input"
          disabled={disabled}
          id={`${idPrefix}-subject`}
          onChange={(event) => {
            const subjectId = event.target.value;
            // Keep the chosen material only if it is in the new subject.
            const keep = materials.some((material) => material.id === value.materialId && (!subjectId || material.subjectId === subjectId));
            onChange({ ...value, subjectId, materialId: keep ? value.materialId : "" });
          }}
          value={value.subjectId}
        >
          <option value="">All subjects</option>
          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-material`}>Study material</label>
        <select
          className="field-input"
          disabled={disabled}
          id={`${idPrefix}-material`}
          onChange={(event) => onChange({ ...value, materialId: event.target.value })}
          value={value.materialId}
        >
          <option value="">{value.subjectId ? "All materials in this subject" : "All materials"}</option>
          {inSubject.map((material) => <option key={material.id} value={material.id}>{material.title} ({material.kind})</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-topic`}>Focus on <span className="optional">optional</span></label>
        <input
          className="field-input"
          disabled={disabled}
          id={`${idPrefix}-topic`}
          maxLength={topicMaxLength}
          onChange={(event) => onChange({ ...value, topic: event.target.value })}
          placeholder="A topic, e.g. accommodation"
          type="text"
          value={value.topic}
        />
      </div>
    </>
  );
}

// "8 / 10", "2.5 / 5"
export function formatScore(score: number, total: number) {
  return `${Number.isInteger(score) ? score : score.toFixed(1)} / ${total}`;
}

export function percent(score: number, total: number) {
  return total > 0 ? Math.round((score / total) * 100) : 0;
}
