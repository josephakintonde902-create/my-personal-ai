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

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Please try again.",
  email_not_confirmed: "Please verify your email before signing in. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Try signing in instead.",
  email_exists: "An account with this email already exists. Try signing in instead.",
  weak_password: "That password is too easy to guess. Choose a stronger one.",
  same_password: "Choose a password you haven't used for this account before.",
  over_email_send_rate_limit: "We've sent a few emails already. Please wait a minute before trying again.",
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
  console.error(`[auth] ${context} failed`, {
    code: details.code,
    status: details.status,
    name: details.name,
    ...(service ? { service, hint: "open /api/health on this deployment to see which setting is wrong" } : {}),
  });

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
