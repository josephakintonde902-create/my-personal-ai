import { TUTOR } from "./config";

// Every way a tutor request can fail, with the HTTP status and the message
// the student sees. Messages never contain stack traces, provider responses,
// database details, or secrets.
export const TUTOR_ERRORS = {
  UNAUTHENTICATED: { status: 401, message: "Your session has expired. Please sign in again." },
  INVALID_REQUEST: { status: 400, message: "That request couldn't be understood. Please try again." },
  EMPTY_MESSAGE: { status: 400, message: "Type a question for Ari first." },
  MESSAGE_TOO_LONG: {
    status: 400,
    message: `That message is too long. Keep it under ${TUTOR.maxMessageLength.toLocaleString("en-GB")} characters.`,
  },
  CONVERSATION_NOT_FOUND: { status: 404, message: "This conversation no longer exists." },
  SUBJECT_NOT_FOUND: { status: 404, message: "That subject no longer exists. Choose another one." },
  NOTHING_TO_RETRY: { status: 409, message: "There's nothing to retry in this conversation." },
  RATE_LIMITED: { status: 429, message: "You're sending messages very quickly. Give it a moment, then try again." },
  NOT_CONFIGURED: { status: 503, message: "Ari's tutor isn't set up yet." },
  PROVIDER_RATE_LIMITED: { status: 503, message: "Ari is very busy right now. Please try again in a moment." },
  PROVIDER_ERROR: { status: 502, message: "Ari couldn't answer just now. Please try again." },
  // The next three look the same to a student and differ in the server log:
  // a rejected key, an account with no credit, and a provider that is down.
  PROVIDER_AUTH: { status: 503, message: "Ari's AI service is temporarily unavailable. Please try again later." },
  PROVIDER_BILLING: { status: 503, message: "Ari's AI service is temporarily unavailable. Please try again later." },
  PROVIDER_UNAVAILABLE: { status: 503, message: "Ari's AI service is temporarily unavailable. Please try again." },
  PROVIDER_REFUSED: { status: 502, message: "Ari couldn't answer that one. Try asking it in a different way." },
  TIMEOUT: { status: 504, message: "Ari took too long to answer. Please try again." },
  DATABASE_ERROR: { status: 500, message: "We couldn't save your conversation. Please try again." },
  ANSWER_NOT_SAVED: { status: 500, message: "Ari's answer couldn't be saved, so it may be missing when you come back." },
  UNKNOWN: { status: 500, message: "Something went wrong. Please try again." },
} as const;

export type TutorErrorCode = keyof typeof TUTOR_ERRORS;

export class TutorError extends Error {
  readonly code: TutorErrorCode;
  readonly status: number;
  // Technical detail for server logs only. Never sent to the browser.
  readonly detail?: string;

  constructor(code: TutorErrorCode, detail?: string) {
    super(TUTOR_ERRORS[code].message);
    this.name = "TutorError";
    this.code = code;
    this.status = TUTOR_ERRORS[code].status;
    this.detail = detail;
  }
}

export function toTutorError(error: unknown, fallback: TutorErrorCode = "UNKNOWN") {
  if (error instanceof TutorError) return error;
  return new TutorError(fallback, error instanceof Error ? error.message : String(error));
}
