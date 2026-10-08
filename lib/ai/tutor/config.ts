// Central configuration for the tutor. Nothing here is secret; the API key is
// read from the environment in lib/ai/tutor/provider.ts.
//
// The tutor's chat model is configured separately from the embedding model in
// lib/ai/config.ts. They are different kinds of model and never share settings.

// The model used when AI_MODEL is not set, for each provider.
// Gemini's is its current stable Flash model: quick, and available on the
// free tier. Each can be changed without touching code (GEMINI_MODEL,
// XAI_MODEL, AI_MODEL).
export const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", xai: "grok-4.7", anthropic: "claude-sonnet-5-5", openai: "gpt-4o-mini" } as const;
export const XAI_API_URL = "https://api.x.ai/v1";
export const DEFAULT_OPENAI_API_URL = "https://api.openai.com/v1";

export const TUTOR = {
  // --- What a student can send -------------------------------------------
  maxMessageLength: 4000,
  // Messages a student can send before being asked to slow down.
  messagesPerMinute: 10,
  messagesPerDay: 300,

  // --- Study material given to the model ----------------------------------
  // Passages retrieved per question. Override with TUTOR_TOP_K.
  defaultTopK: 6,
  maxTopK: 12,
  // Passages scoring below this are not considered relevant. Similarity is
  // 0–1; this matches the knowledge base's own default threshold.
  relevantScore: 0.2,
  // When a subject is selected and nothing reaches relevantScore, the closest
  // few passages are still offered, so broad questions such as "what is this
  // document about?" have something to work from.
  fallbackPassages: 3,
  // Upper bound on all passages together, in characters.
  maxContextChars: 26_000,
  // A short follow-up ("explain that more simply") says little by itself, so
  // messages shorter than this are searched together with the previous question.
  shortQuestionChars: 80,

  // --- Conversation memory -------------------------------------------------
  // Only the recent part of a conversation is sent with each question.
  historyMaxMessages: 16,
  historyMaxChars: 24_000,
  // A single very long earlier message is shortened to this.
  historyMessageMaxChars: 6000,

  // --- The model's answer --------------------------------------------------
  // How hard the model should work on a tutor reply, where the provider has
  // such a setting. Low keeps conversation quick; the model still thinks a
  // question through when it needs to.
  effort: "low" as const,
  // Override with AI_MAX_OUTPUT_TOKENS.
  maxOutputTokens: 2000,
  // Time allowed for the provider to start answering, and to finish.
  connectTimeoutMs: 30_000,
  responseTimeoutMs: 120_000,
  // Longest answer stored (the database allows 60,000 characters).
  maxAnswerChars: 50_000,

  // --- Lists ---------------------------------------------------------------
  titleMaxLength: 60,
  conversationListLimit: 100,
  // Most recent messages shown when a conversation is opened.
  displayMessageLimit: 300,
};

function envInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export function tutorTopK() {
  return envInteger("TUTOR_TOP_K", TUTOR.defaultTopK, 1, TUTOR.maxTopK);
}

export function tutorMaxOutputTokens() {
  return envInteger("AI_MAX_OUTPUT_TOKENS", TUTOR.maxOutputTokens, 200, 16_000);
}
