import { DEFAULT_SUBJECT_COLOR, SUBJECT_ICONS } from "@/lib/library/config";

type Props = {
  name: string;
  color: string | null;
  icon: string | null;
  size?: "sm" | "md" | "lg";
};

// The coloured tile that identifies a subject: its icon, or its initial.
export function SubjectBadge({ name, color, icon, size = "md" }: Props) {
  const glyph = SUBJECT_ICONS.find((option) => option.id === icon)?.glyph;

  return (
    <span aria-hidden="true" className={`subject-badge tone-${color ?? DEFAULT_SUBJECT_COLOR} size-${size}`}>
      {glyph ?? (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
