// Shapes shared by the tutor's server code and its UI. No server-only imports,
// so client components can use these types.

export type TutorRole = "user" | "assistant";

// A passage from the student's materials that was given to the model. `n` is
// the number the model cites it by ("[2]"). Location fields come straight
// from the knowledge base and are null when the document had none.
export type TutorSource = {
  n: number;
  materialId: string;
  title: string;
  subject: string;
  page: number | null;
  slide: number | null;
  section: string | null;
};

export type TutorConversation = {
  id: string;
  title: string;
  // Null means "All materials".
  subjectId: string | null;
  updatedAt: string;
};

export type TutorMessage = {
  id: string;
  role: TutorRole;
  content: string;
  sources: TutorSource[];
  createdAt: string;
};

// What the browser sends to POST /api/tutor/chat. There is no user id: the
// user always comes from the session.
export type TutorChatRequest = {
  message?: string;
  conversationId?: string;
  // Null or absent with no conversation means "All materials".
  subjectId?: string | null;
  // Answer the last question again instead of sending a new one. Used by
  // "Try again" after a failed answer.
  regenerate?: boolean;
};

// The response is a stream of these, one JSON object per line.
export type TutorStreamEvent =
  | {
      type: "start";
      conversation: TutorConversation;
      // Null when regenerating: the question was saved by the earlier attempt.
      userMessage: { id: string; createdAt: string } | null;
      sources: TutorSource[];
      // False when the student's materials could not be searched this time.
      searched: boolean;
    }
  | { type: "delta"; text: string }
  | { type: "done"; message: { id: string; createdAt: string } }
  | { type: "error"; code: string; message: string };

// The JSON body of a failed request (any non-2xx status).
export type TutorErrorBody = {
  error: string;
  code: string;
  // Present when the question was saved before the failure, so the browser
  // can retry with `regenerate` instead of sending the question twice.
  conversation?: TutorConversation;
};
