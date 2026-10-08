import type { ProcessingStatus } from "./types";

// Fixed locale and time zone so the server and browser render the same text.
const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string) {
  return dateFormatter.format(new Date(iso));
}

export function materialCountLabel(count: number) {
  return `${count} ${count === 1 ? "material" : "materials"}`;
}

export const PROCESSING_STATUS_LABELS: Record<ProcessingStatus, string> = {
  pending: "Waiting for processing",
  processing: "Processing…",
  ready: "Ready for Ari",
  failed: "Processing failed",
};

export const PROCESSING_STATUS_ICONS: Record<ProcessingStatus, string> = {
  pending: "○",
  processing: "⏳",
  ready: "✓",
  failed: "⚠",
};

const numberFormatter = new Intl.NumberFormat("en-GB");

export function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${numberFormatter.format(count)} ${count === 1 ? singular : plural}`;
}
