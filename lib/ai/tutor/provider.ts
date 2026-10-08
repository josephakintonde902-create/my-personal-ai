import { AnthropicChat } from "./anthropic-chat";
import { DEFAULT_MODELS, DEFAULT_OPENAI_API_URL, TUTOR, tutorMaxOutputTokens, XAI_API_URL } from "./config";
import { TutorError } from "./errors";
import { GeminiChat } from "./gemini-chat";
import { OpenAICompatibleChat } from "./openai-chat";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// How much effort the model should put into a reply, where the provider has
// such a setting. Ignored by providers that do not.
export type ModelEffort = "low" | "medium" | "high";

export type ModelOptions = {
  // Longest answer, in tokens. Defaults to AI_MAX_OUTPUT_TOKENS.
  maxOutputTokens?: number;
  effort?: ModelEffort;
  // The reply is expected to be one JSON document (quiz questions, cards, a
  // mark). Providers with a JSON mode switch it on; the reply is validated
  // by the caller either way.
  json?: boolean;
};

// The chat model that writes Ari's answers, quiz questions, flashcards and
// short-answer marks. The rest of the app depends only on this interface: it
// does not know, or need to know, which provider is behind it.
export interface TutorModel {
  readonly model: string;
  // Resolves once the provider has accepted the request, with the answer as a
  // stream of text pieces. Rejects with a TutorError if the request is
  // refused, so that failure is known before anything is streamed.
  streamChat(messages: ChatMessage[]): Promise<AsyncIterable<string>>;
}

export const AI_PROVIDERS = ["gemini", "xai", "anthropic", "openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

const ALIASES: Record<string, AiProvider> = { google: "gemini", grok: "xai", claude: "anthropic" };

// Server-only settings for AI generation. None of these use the NEXT_PUBLIC_
// prefix, so they are never sent to the browser. Embeddings have their own
// settings (EMBEDDING_*), chosen independently.
//
//   AI_PROVIDER            which provider writes Ari's answers
//   AI_MAX_OUTPUT_TOKENS   optional   longest tutor answer, in tokens
//
// Each provider reads its own key and model, so switching AI_PROVIDER never
// sends one provider's key to another:
//
//   gemini      GEMINI_API_KEY   GEMINI_MODEL
//   xai         XAI_API_KEY      XAI_MODEL
//   anthropic   AI_API_KEY       AI_MODEL
//   openai      AI_API_KEY       AI_MODEL     AI_API_URL
const SETTINGS: Record<AiProvider, { name: string; key: string; model: string }> = {
  gemini: { name: "Gemini", key: "GEMINI_API_KEY", model: "GEMINI_MODEL" },
  xai: { name: "Grok", key: "XAI_API_KEY", model: "XAI_MODEL" },
  anthropic: { name: "Claude", key: "AI_API_KEY", model: "AI_MODEL" },
  openai: { name: "an OpenAI-compatible API", key: "AI_API_KEY", model: "AI_MODEL" },
};

const env = (name: string) => process.env[name]?.trim() ?? "";

// Claude is used when AI_PROVIDER is not set, as it was before other
// providers were added.
export function aiProvider(): AiProvider {
  const value = env("AI_PROVIDER").toLowerCase();
  if (!value) return "anthropic";
  const provider = ALIASES[value] ?? value;
  if ((AI_PROVIDERS as readonly string[]).includes(provider)) return provider as AiProvider;
  throw new TutorError("NOT_CONFIGURED", `AI_PROVIDER "${value.slice(0, 30)}" is not one of: ${AI_PROVIDERS.join(", ")}`);
}

export function aiModel(provider: AiProvider = aiProvider()) {
  return env(SETTINGS[provider].model) || DEFAULT_MODELS[provider];
}

// The names of the settings a provider reads. For messages; never the values.
export function aiSettings(provider: AiProvider = aiProvider()) {
  return SETTINGS[provider];
}

// What each provider's keys look like, to catch a key pasted under the wrong
// name before it is sent to a provider it does not belong to.
const KEY_SHAPES: { provider: string; pattern: RegExp; owners: AiProvider[] }[] = [
  { provider: "an xAI", pattern: /^xai-/, owners: ["xai"] },
  { provider: "an Anthropic", pattern: /^sk-ant-/, owners: ["anthropic"] },
  { provider: "a Google", pattern: /^AIza/, owners: ["gemini"] },
  { provider: "an OpenAI", pattern: /^sk-(proj|svcacct|admin)-/, owners: ["openai"] },
];

// What is wrong with the AI settings, or null if they can be used. Besides a
// missing key, this catches settings that belong to a different provider, so
// that a key is never sent to a provider it does not belong to.
export function aiConfigProblem(): string | null {
  let provider: AiProvider;
  try {
    provider = aiProvider();
  } catch (error) {
    return (error as TutorError).detail ?? "AI_PROVIDER is not valid";
  }

  const settings = SETTINGS[provider];
  const apiKey = env(settings.key);
  if (!apiKey) return `${settings.key} is not set (needed because the AI provider is ${provider})`;

  // AI_API_URL only means something to the OpenAI-compatible provider, so
  // on its own it marks settings left over from one.
  if (!env("AI_PROVIDER") && env("AI_API_URL")) {
    return "AI_API_URL is set but AI_PROVIDER is not. Set AI_PROVIDER to gemini, xai, anthropic or openai";
  }

  const shape = KEY_SHAPES.find(({ pattern }) => pattern.test(apiKey));
  if (shape && !shape.owners.includes(provider)) {
    return `${settings.key} looks like ${shape.provider} key, but the AI provider is ${provider}. Use a key for ${settings.name}, or change AI_PROVIDER`;
  }

  if (provider === "anthropic") {
    if (/^(gpt-|o\d|chatgpt)/i.test(env("AI_MODEL"))) return "AI_MODEL names an OpenAI model, but the AI provider is Claude. Set AI_MODEL to a Claude model, or remove it to use the default";
  }
  return null;
}

export function isTutorConfigured() {
  return aiConfigProblem() === null;
}

export function getTutorModel(options: ModelOptions = {}): TutorModel {
  const problem = aiConfigProblem();
  if (problem) throw new TutorError("NOT_CONFIGURED", problem);
  const provider = aiProvider();

  const shared = {
    apiKey: env(SETTINGS[provider].key),
    model: aiModel(provider),
    maxOutputTokens: options.maxOutputTokens ?? tutorMaxOutputTokens(),
    responseTimeoutMs: TUTOR.responseTimeoutMs,
  };

  if (provider === "gemini") return new GeminiChat({ ...shared, effort: options.effort, json: options.json });
  if (provider === "anthropic") return new AnthropicChat({ ...shared, effort: options.effort });

  // xAI's API follows the OpenAI chat completions format, at its own address.
  const isXai = provider === "xai";
  return new OpenAICompatibleChat({
    ...shared,
    label: isXai ? "xai" : "chat",
    baseUrl: (isXai ? env("XAI_API_URL") || XAI_API_URL : env("AI_API_URL") || DEFAULT_OPENAI_API_URL).replace(/\/$/, ""),
    connectTimeoutMs: TUTOR.connectTimeoutMs,
    json: isXai && options.json,
  });
}
