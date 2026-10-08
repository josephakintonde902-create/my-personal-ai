"use client";

import { useMemo, useState } from "react";
import { SUPPORTED_MATERIAL_TYPES } from "@/lib/library/config";
import { findTypeByExtension } from "@/lib/library/files";
import type { StudyMaterial, SubjectOption } from "@/lib/library/types";
import { MaterialList } from "./material-list";
import { MaterialUpload } from "./material-upload";

const SORTS = {
  newest: { label: "Newest first", compare: (a: StudyMaterial, b: StudyMaterial) => b.created_at.localeCompare(a.created_at) },
  oldest: { label: "Oldest first", compare: (a: StudyMaterial, b: StudyMaterial) => a.created_at.localeCompare(b.created_at) },
  title: { label: "Title A–Z", compare: (a: StudyMaterial, b: StudyMaterial) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) },
  largest: { label: "Largest first", compare: (a: StudyMaterial, b: StudyMaterial) => b.file_size - a.file_size },
} as const;

type SortKey = keyof typeof SORTS;

type Props = { materials: StudyMaterial[]; subjects: SubjectOption[]; processingEnabled: boolean };

export function MaterialsView({ materials, subjects, processingEnabled }: Props) {
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [typeId, setTypeId] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return materials
      .filter((material) => !term || material.title.toLowerCase().includes(term) || material.original_filename.toLowerCase().includes(term))
      .filter((material) => !subjectId || material.subject_id === subjectId)
      .filter((material) => !typeId || findTypeByExtension(material.file_extension ?? "")?.id === typeId)
      .sort(SORTS[sort].compare);
  }, [materials, search, subjectId, typeId, sort]);

  const filtered = Boolean(search.trim() || subjectId || typeId);
  const clearFilters = () => {
    setSearch("");
    setSubjectId("");
    setTypeId("");
  };

  return (
    <>
      <div className="welcome-row page-header">
        <div>
          <p className="eyebrow"><span className="sun-dot" /> YOUR LIBRARY</p>
          <h1>Study materials<span className="heading-comma">.</span></h1>
          <p className="welcome-subtitle">Everything you&apos;ve uploaded, across all your subjects.</p>
        </div>
        {materials.length > 0 && (
          <button className="action-button" onClick={() => setUploading(true)} type="button">
            <span aria-hidden="true">↑</span> Upload material
          </button>
        )}
      </div>

      {materials.length === 0 ? (
        <div className="library-empty">
          <div aria-hidden="true" className="empty-illustration"><span>✳</span><i>·</i></div>
          <strong>No study materials yet.</strong>
          <p>Upload your notes, slides, PDFs, and other study materials so Ari can use them later.</p>
          <button className="action-button" onClick={() => setUploading(true)} type="button">
            <span aria-hidden="true">↑</span> Upload material
          </button>
        </div>
      ) : (
        <>
          <div className="filter-bar">
            <input
              aria-label="Search materials by title"
              className="field-input filter-search"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by title"
              type="search"
              value={search}
            />
            <select aria-label="Filter by subject" className="field-input" onChange={(event) => setSubjectId(event.target.value)} value={subjectId}>
              <option value="">All subjects</option>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
            </select>
            <select aria-label="Filter by file type" className="field-input" onChange={(event) => setTypeId(event.target.value)} value={typeId}>
              <option value="">All types</option>
              {SUPPORTED_MATERIAL_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
            <select aria-label="Sort materials" className="field-input" onChange={(event) => setSort(event.target.value as SortKey)} value={sort}>
              {Object.entries(SORTS).map(([key, option]) => <option key={key} value={key}>{option.label}</option>)}
            </select>
          </div>

          <p aria-live="polite" className="result-count">
            {filtered ? `${visible.length} of ${materials.length} materials` : `${materials.length} ${materials.length === 1 ? "material" : "materials"}`}
            {filtered && <button className="link-button" onClick={clearFilters} type="button">Clear filters</button>}
          </p>

          {visible.length === 0 ? (
            <div className="library-empty compact">
              <strong>No materials match your filters.</strong>
              <p>Try a different search, or clear the filters to see everything.</p>
            </div>
          ) : (
            <MaterialList materials={visible} processingEnabled={processingEnabled} subjects={subjects} />
          )}
        </>
      )}

      {uploading && <MaterialUpload onClose={() => setUploading(false)} subjects={subjects} />}
    </>
  );
}
