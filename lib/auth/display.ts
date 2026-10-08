export function getInitials(fullName: string | null | undefined, email: string) {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

export function getDisplayName(fullName: string | null | undefined, email: string) {
  return fullName?.trim() || email.split("@")[0] || "Your account";
}

export function getFirstName(fullName: string | null | undefined) {
  return fullName?.trim().split(/\s+/)[0] ?? "";
}
