const GENERIC_ERROR = "Something went wrong on our side. Please try again in a moment.";

// Sign-in runs on the server, so none of these is ever the student's own
// connection, and none of them says so.
export const AUTH_SERVICE_MESSAGES = {
  // The Supabase URL or key is missing, malformed or rejected.
  NOT_CONFIGURED: "Ari's sign-in service isn't set up correctly. This is a problem on our side, not with your details.",
  // The server's request to Supabase never got an answer.
  UNREACHABLE: "Ari can't reach its sign-in service right now. This is a problem on our side, not your connection. Please try again later.",
  // Supabase answered with a server error.
  UNAVAILABLE: "Ari's sign-in service is temporarily unavailable. Please try again in a moment.",
} as const;

export type AuthServiceFailure = keyof typeof AUTH_SERVICE_MESSAGES;

// How long Supabase makes one address wait between emails. The resend button
// counts this down, so a student is not invited to press it while the answer
// can only be "wait".
export const EMAIL_RESEND_SECONDS = 60;

// Supabase refuses to send an email for two unrelated reasons, under one
// error code. They need different words: one is over in a minute and is
// about this student, the other can last an hour and is about the project.
export const EMAIL_LIMIT_MESSAGES = {
  // This address was sent an email less than a minute ago.
  ADDRESS: "We've just sent an email to this address. Check your inbox and spam folder, or wait a minute before asking for another.",
  // The whole project has sent as many emails as it may this hour. Supabase's
  // built-in sender allows only a handful; see "Custom SMTP" in the README.
  PROJECT: "Ari has sent as many emails as it can for now, so yours wasn't sent. This is a limit on our side, not a problem with your details. Please try again in about an hour.",
} as const;

export type EmailLimit = keyof typeof EMAIL_LIMIT_MESSAGES;

// Which of the two limits an error is, or null if it is neither.
export function emailLimit(error: unknown): EmailLimit | null {
  const details = (error ?? {}) as ErrorLike;
  if (details.code !== "over_email_send_rate_limit") return null;
  // The per-address limit is the one that says how long to wait.
  return /after \d+ seconds|for security purposes/i.test(details.message ?? "") ? "ADDRESS" : "PROJECT";
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Please try again.",
  email_not_confirmed: "Please verify your email before signing in. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Try signing in instead.",
  email_exists: "An account with this email already exists. Try signing in instead.",
  weak_password: "That password is too easy to guess. Choose a stronger one.",
  same_password: "Choose a password you haven't used for this account before.",
  over_request_rate_limit: "Too many attempts. Please wait a moment and try again.",
  otp_expired: "That link has expired. Request a new one to continue.",
  flow_state_expired: "That link has expired. Request a new one to continue.",
  flow_state_not_found: "That link is no longer valid. Request a new one to continue.",
  bad_code_verifier: "That link is no longer valid. Request a new one to continue.",
  session_not_found: "Your session has expired. Please sign in again.",
  session_expired: "Your session has expired. Please sign in again.",
  refresh_token_not_found: "Your session has expired. Please sign in again.",
  user_banned: "This account can't sign in right now. Contact support if you think this is a mistake.",
  signup_disabled: "New sign-ups are paused at the moment. Please try again later.",
  email_address_invalid: "Enter a valid email address.",
  validation_failed: "Please check the details you entered and try again.",
  provider_disabled: "That sign-in method isn't available yet.",
};

type ErrorLike = { code?: string; status?: number; name?: string; message?: string };

// Whether a failure is the sign-in service itself rather than anything the
// student did, and which kind. Null for everything else.
export function authServiceFailure(error: unknown): AuthServiceFailure | null {
  const details = (error ?? {}) as ErrorLike;
  if (details.name === "SupabaseConfigError") return "NOT_CONFIGURED";
  // What Supabase's gateway answers when the key is not one of the project's.
  if (details.status === 401 && !details.code && /api key/i.test(details.message ?? "")) return "NOT_CONFIGURED";
  // Status 0 is a request that got no answer: an address that does not
  // exist, or a key that cannot be put in a header.
  if (details.status === 0) return "UNREACHABLE";
  if (details.name === "AuthRetryableFetchError" || (details.status ?? 0) >= 500) return "UNAVAILABLE";
  return null;
}

// Maps a Supabase error to copy that is safe to show. Raw provider and
// database messages are never sent to the browser, and never logged: a
// failed request's message can repeat the key it was sent with.
export function friendlyAuthError(error: unknown, context: string) {
  const details = (error ?? {}) as ErrorLike;
  const service = authServiceFailure(error);
  const limit = emailLimit(error);
  console.error(`[auth] ${context} failed`, {
    code: details.code,
    status: details.status,
    name: details.name,
    ...(service ? { service, hint: "open /api/health on this deployment to see which setting is wrong" } : {}),
    ...(limit ? { emailLimit: limit } : {}),
    ...(limit === "PROJECT" ? { hint: "the project's hourly email limit is used up; set up custom SMTP in Supabase and raise the limit (README, Custom SMTP)" } : {}),
  });

  if (limit) return EMAIL_LIMIT_MESSAGES[limit];
  if (details.code && MESSAGES[details.code]) return MESSAGES[details.code];
  if (service) return AUTH_SERVICE_MESSAGES[service];
  if (details.status === 429) return MESSAGES.over_request_rate_limit;
  return GENERIC_ERROR;
}

export function isSessionMissing(error: unknown) {
  const details = (error ?? {}) as ErrorLike;
  return details.name === "AuthSessionMissingError" || details.code === "session_not_found";
}

// Notices shown on the login page, selected by a query parameter so that no
// free-form text from a URL is ever rendered.
export const LOGIN_NOTICES: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  password_updated: { tone: "success", text: "Your password has been updated. Sign in with your new password." },
  session_expired: { tone: "info", text: "Your session has expired. Please sign in again." },
  link_expired: { tone: "error", text: "That verification link has expired. Sign in to request a new one." },
  link_invalid: {
    tone: "error",
    text: "We couldn't complete that link. If you've already verified your email, sign in below. Otherwise request a new link.",
  },
  oauth_failed: { tone: "error", text: "We couldn't sign you in with Google. Please try again." },
};
