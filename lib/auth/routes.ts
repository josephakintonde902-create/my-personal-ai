// Routes that require a signed-in user. Some of these are built in later
// phases; listing them now means they are protected from the moment they exist.
export const PROTECTED_ROUTES = [
  "/dashboard",
  "/subjects",
  "/materials",
  "/tutor",
  "/quizzes",
  "/flashcards",
  "/performance",
  "/planner",
  "/past-questions",
  "/exam",
  "/settings",
];

// Routes a signed-in user has no reason to see. /reset-password is excluded
// because a recovery link signs the user in before they choose a new password.
export const AUTH_ROUTES = ["/login", "/signup", "/forgot-password"];

export function isUnderRoute(pathname: string, routes: string[]) {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

// Only allow same-origin relative paths, so `next` cannot be used as an open redirect.
export function safeNextPath(next: FormDataEntryValue | string | null | undefined, fallback = "/dashboard") {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
