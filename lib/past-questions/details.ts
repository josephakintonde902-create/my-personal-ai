import { PAST } from "./config";

// What a student may say about a past-question collection. Only the title
// is required, and it falls back to the file's name; nobody is made to fill
// in the rest.

export type SetDetailsInput = {
  title?: unknown;
  examType?: unknown;
  institution?: unknown;
  year?: unknown;
  courseCode?: unknown;
  description?: unknown;
};

export type SetDetails = {
  title: string;
  exam_type: string | null;
  institution: string | null;
  exam_year: number | null;
  course_code: string | null;
  description: string | null;
};

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// Accepts untrusted input and returns only values that are safe to store.
export function parseSetDetails(input: SetDetailsInput, fallbackTitle: string): { values: SetDetails } | { fieldErrors: Record<string, string> } {
  const title = text(input?.title) || text(fallbackTitle);
  const examType = text(input?.examType);
  const institution = text(input?.institution);
  const courseCode = text(input?.courseCode);
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  const yearText = typeof input?.year === "number" ? String(input.year) : text(input?.year);

  const fieldErrors: Record<string, string> = {};
  const tooLong = (field: string, value: string, max: number) => {
    if (value.length > max) fieldErrors[field] = `Use ${max} characters or fewer.`;
  };
  if (!title) fieldErrors.title = "Give this collection a title.";
  tooLong("title", title, PAST.titleMaxLength);
  tooLong("examType", examType, PAST.examTypeMaxLength);
  tooLong("institution", institution, PAST.institutionMaxLength);
  tooLong("courseCode", courseCode, PAST.courseCodeMaxLength);
  tooLong("description", description, PAST.descriptionMaxLength);

  let year: number | null = null;
  if (yearText) {
    year = /^\d{4}$/.test(yearText) ? Number(yearText) : Number.NaN;
    if (!Number.isInteger(year) || year < PAST.minYear || year > PAST.maxYear) fieldErrors.year = `Enter a four-digit year between ${PAST.minYear} and ${PAST.maxYear}, or leave it empty.`;
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  return {
    values: { title, exam_type: examType || null, institution: institution || null, exam_year: year, course_code: courseCode || null, description: description || null },
  };
}
