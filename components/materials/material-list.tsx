"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getMaterialDownloadUrl, processMaterialAction } from "@/app/(app)/materials/actions";
import { useToast } from "@/components/ui/toast";
import { findTypeByExtension, findTypeByMime, formatFileSize } from "@/lib/library/files";
import { formatCount, formatDate, PROCESSING_STATUS_ICONS, PROCESSING_STATUS_LABELS } from "@/lib/library/format";
import type { StudyMaterial, SubjectOption } from "@/lib/library/types";
import { DeleteMaterialDialog, RenameMaterialDialog } from "./material-dialogs";

// How often the list re-checks materials that are being processed, and for
// how long before it stops asking (a stuck item should not poll forever).
const POLL_INTERVAL_MS = 4000;
const POLL_LIMIT_MS = 10 * 60_000;

export function materialTypeLabel(material: Pick<StudyMaterial, "file_extension" | "mime_type">) {
  const type = findTypeByExtension(material.file_extension ?? "") ?? findTypeByMime(material.mime_type);
  return type?.label ?? (material.file_extension ?? "file").toUpperCase();
}

type Props = {
  materials: StudyMaterial[];
  // When given, each row shows which subject it belongs to.
  subjects?: SubjectOption[];
  // False when no embedding provider is configured: materials stay pending
  // and the processing actions are hidden.
  processingEnabled: boolean;
};

type DialogState = { type: "rename" | "delete"; material: StudyMaterial } | null;

function processingAction(material: StudyMaterial) {
  if (material.processing_status === "failed") return "Retry";
  if (material.processing_status === "pending") return "Process";
  if (material.processing_status === "ready") return "Reprocess";
  // Still marked as processing after a long time: the attempt has died.
  return material.processing_stale ? "Retry" : null;
}

function ProcessingDetails({ material }: { material: StudyMaterial }) {
  if (material.processing_status === "failed") {
    return <span className="material-note error">{material.processing_error ?? "This material couldn't be processed."}</span>;
  }
  if (material.processing_status === "processing" && material.processing_stale) {
    return <span className="material-note error">Processing stopped unexpectedly. Try again.</span>;
  }
  if (material.processing_status !== "ready" || material.chunk_count === null) return null;
  // Ready by its status, but out of the search's reach. Said plainly, with
  // the one thing that fixes it.
  if (material.needs_reprocess) {
    return (
      <span className="material-note error">
        Ari can&apos;t search this material yet: it was indexed with a different embedding model, or its index is empty. Press Reprocess to fix it.
      </span>
    );
  }

  const pages = material.page_count
    ? formatCount(material.page_count, material.file_extension === "pptx" || material.file_extension === "ppt" ? "slide" : "page")
    : null;
  return (
    <span className="material-note">
      {pages && <>{pages} <i>·</i> </>}
      {material.word_count !== null && <>{formatCount(material.word_count, "word")} <i>·</i> </>}
      {formatCount(material.chunk_count, "section")} indexed
      {material.processed_at && <> <i>·</i> Processed {formatDate(material.processed_at)}</>}
    </span>
  );
}

export function MaterialList({ materials, subjects, processingEnabled }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Materials whose processing was just requested, with the status they had
  // at that moment. They show as "Starting…" until the server reports a change.
  const [starting, setStarting] = useState<Record<string, string>>({});
  const subjectNames = new Map(subjects?.map((subject) => [subject.id, subject.name]));

  const isStarting = (material: StudyMaterial) =>
    starting[material.id] !== undefined && starting[material.id] === material.updated_at;

  const inProgress =
    processingEnabled &&
    materials.some(
      (material) =>
        isStarting(material) ||
        material.processing_status === "pending" ||
        (material.processing_status === "processing" && !material.processing_stale),
    );

  // While something is being processed, re-fetch the page's data so statuses
  // update on their own. Only the server data is refreshed, not the page.
  useEffect(() => {
    if (!inProgress) return;
    const interval = window.setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    const limit = window.setTimeout(() => window.clearInterval(interval), POLL_LIMIT_MS);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(limit);
    };
  }, [inProgress, router]);

  const clearStarting = (id: string) =>
    setStarting((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

  const process = async (material: StudyMaterial) => {
    if (isStarting(material)) return;
    setStarting((current) => ({ ...current, [material.id]: material.updated_at }));
    try {
      const result = await processMaterialAction(material.id);
      if (!result.ok) {
        toast(result.error, "error");
        clearStarting(material.id);
      }
    } catch {
      toast("We couldn't reach the server. Check your connection and try again.", "error");
      clearStarting(material.id);
    }
  };

  const download = async (material: StudyMaterial) => {
    if (downloadingId) return;
    setDownloadingId(material.id);
    try {
      const result = await getMaterialDownloadUrl(material.id);
      if (result.ok && result.data) {
        // The link is served as an attachment, so this starts a download
        // without leaving the page.
        window.location.assign(result.data.url);
      } else {
        toast(result.ok ? "We couldn't prepare this download. Please try again." : result.error, "error");
      }
    } catch {
      toast("We couldn't reach the server. Check your connection and try again.", "error");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <>
      <ul className="material-list">
        {materials.map((material) => {
          const typeLabel = materialTypeLabel(material);
          const subjectName = subjectNames.get(material.subject_id);
          const startingNow = isStarting(material);
          const stale = material.processing_status === "processing" && material.processing_stale;
          const status = stale ? "failed" : startingNow ? "processing" : material.processing_status;
          const action = processingEnabled && !startingNow ? processingAction(material) : null;

          return (
            <li className="material-row" key={material.id}>
              <span aria-hidden="true" className={`file-chip type-${(material.file_extension ?? "file").slice(0, 4)}`}>{typeLabel}</span>
              <div className="material-copy">
                <strong>{material.title}</strong>
                <span className="material-filename">{material.original_filename}</span>
                <span className="material-meta">
                  {typeLabel} <i>·</i> {formatFileSize(material.file_size)}
                  {subjectName && (
                    <> <i>·</i> <Link href={`/subjects/${material.subject_id}`}>{subjectName}</Link></>
                  )}
                  {" "}<i>·</i> Uploaded {formatDate(material.created_at)}
                </span>
                {!startingNow && <ProcessingDetails material={material} />}
              </div>
              <span className={`status-badge status-${material.needs_reprocess && !startingNow ? "failed" : status}`}>
                <span aria-hidden="true">{material.needs_reprocess && !startingNow ? PROCESSING_STATUS_ICONS.failed : PROCESSING_STATUS_ICONS[status]}</span>{" "}
                {startingNow ? "Starting…" : stale ? "Processing stopped" : material.needs_reprocess ? "Needs reprocessing" : PROCESSING_STATUS_LABELS[material.processing_status]}
              </span>
              <div className="card-actions">
                {action && (
                  <button
                    aria-label={`${action} ${material.title}`}
                    className={`icon-button${material.processing_status === "ready" && !material.needs_reprocess ? "" : " primary"}`}
                    onClick={() => process(material)}
                    type="button"
                  >
                    {action}
                  </button>
                )}
                <button
                  aria-label={`Download ${material.title}`}
                  className="icon-button"
                  disabled={downloadingId === material.id}
                  onClick={() => download(material)}
                  type="button"
                >
                  {downloadingId === material.id ? "Preparing…" : "Download"}
                </button>
                <button aria-label={`Rename ${material.title}`} className="icon-button" onClick={() => setDialog({ type: "rename", material })} type="button">Rename</button>
                <button aria-label={`Delete ${material.title}`} className="icon-button danger" onClick={() => setDialog({ type: "delete", material })} type="button">Delete</button>
              </div>
            </li>
          );
        })}
      </ul>

      {dialog?.type === "rename" && <RenameMaterialDialog material={dialog.material} onClose={() => setDialog(null)} />}
      {dialog?.type === "delete" && <DeleteMaterialDialog material={dialog.material} onClose={() => setDialog(null)} />}
    </>
  );
}
